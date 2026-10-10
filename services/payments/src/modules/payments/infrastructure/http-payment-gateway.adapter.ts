import { Inject, Injectable, Optional } from '@nestjs/common';

import { gatewayConfig, type GatewayConfig } from '@config/configuration';
import { CORRELATION_HEADER } from '@infra/correlation/correlation-id';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { CORRELATION, type Correlation } from '@shared/messaging/correlation';
import { METRICS, secondsSince, type Histogram, type Metrics } from '@shared/observability/metrics';
import { silentMetrics } from '@shared/observability/silent-metrics';

import { PaymentGatewayError } from './payment-gateway.error';
import {
  createResilientCall,
  parseRetryAfter,
  type CallAttempt,
  type ResilientCall,
} from './resilient-call';

import type { ChargeRequest, ChargeResult, PaymentGateway } from '../ports/payment-gateway.port';

const VENDOR = 'psp';

interface PspChargeResponse {
  id: string;
  status: 'succeeded' | 'declined';
  declineCode?: string;
}

const isPspChargeResponse = (body: unknown): body is PspChargeResponse =>
  typeof body === 'object' &&
  body !== null &&
  'id' in body &&
  typeof body.id === 'string' &&
  'status' in body &&
  (body.status === 'succeeded' || body.status === 'declined');

/**
 * Talks to the PSP (devtools/fake-psp locally) over plain HTTP. An operation is one or a few
 * calls: a call that fails and may pass is made again after a pause, and a provider that
 * keeps failing is not called for a while (resilient-call.ts, docs/adr/0020). What is given
 * up here is thrown as retryable and comes again with the command (charge-payment.service.ts,
 * docs/adr/0013). The idempotency key is what makes a second call of a charge safe.
 *
 * Every call names the chain it belongs to (`x-correlation-id`), so the provider's own log
 * of a charge is found with the order that caused it (docs/adr/0023).
 *
 * And every call is observed (docs/adr/0027): how long the provider took and what it said,
 * or that it said nothing. The state of the circuit is a metric of `resilient-call.ts`.
 */
@Injectable()
export class HttpPaymentGateway implements PaymentGateway {
  private readonly log: Logger;

  /** One for the provider: a charge and a void fail for the same reasons. */
  private readonly calls: ResilientCall;
  private readonly duration: Histogram<'vendor' | 'operation' | 'status'>;

  constructor(
    @Inject(gatewayConfig.KEY) private readonly config: GatewayConfig,
    @Inject(LOGGER) logger: Logger,
    @Inject(CORRELATION) private readonly correlation: Pick<Correlation, 'current'>,
    // left out by a test that builds the adapter by hand
    @Optional() @Inject(METRICS) metrics: Metrics = silentMetrics,
  ) {
    this.log = logger.child({ context: HttpPaymentGateway.name });
    this.calls = createResilientCall(config, this.log, metrics);
    this.duration = metrics.histogram({
      name: 'outbound_call_duration_seconds',
      help: 'Time one call to a vendor took, by its HTTP status; no_answer when none came.',
      labels: ['vendor', 'operation', 'status'],
    });
  }

  charge(request: ChargeRequest): Promise<ChargeResult> {
    // the body is read inside the call: one that is cut off is a failure of that call
    return this.calls.execute(async (attempt) => {
      const response = await this.post('charge', '/charges', attempt, {
        headers: { 'idempotency-key': request.idempotencyKey },
        body: {
          amountMinor: Number(request.amount.amountMinor),
          currency: request.amount.currency,
          reference: request.reference,
        },
      });

      const body = await this.readBody(response);
      if (!isPspChargeResponse(body)) {
        throw new PaymentGatewayError('PSP returned an unexpected body', false);
      }
      return body.status === 'succeeded'
        ? { status: 'succeeded', chargeId: body.id }
        : { status: 'declined', chargeId: body.id, declineCode: body.declineCode ?? 'declined' };
    });
  }

  async void(chargeId: string): Promise<void> {
    await this.calls.execute(async (attempt) => {
      const path = `/charges/${encodeURIComponent(chargeId)}/void`;
      const response = await this.post('void', path, attempt);
      // the status is the answer; the body is released, not read
      void response.body?.cancel().catch(() => undefined);
    });
  }

  /** One POST to the PSP; resolves with a 2xx response, throws a `PaymentGatewayError` else. */
  private async post(
    operation: string,
    path: string,
    attempt: CallAttempt,
    { headers = {}, body = {} }: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> {
    const startedAt = performance.now();
    const call = () => ({
      operation,
      call: attempt.number,
      durationMs: Math.round(performance.now() - startedAt),
    });
    let response: Response;
    try {
      response = await this.send(path, headers, body, attempt.signal);
    } catch (err: unknown) {
      // no answer: unreachable, or cut off by the timeout
      this.observe(operation, 'no_answer', startedAt);
      this.log.warn({ ...call(), err }, 'psp call');
      throw err;
    }
    this.observe(operation, response.status, startedAt);
    this.log.info({ ...call(), status: response.status }, 'psp call');

    // 5xx and 429 are transient; any other non-2xx means our request is wrong. The body is
    // not read there: release it, or the connection stays taken until garbage collection.
    // Not awaited: the error must not wait on the stream.
    if (!response.ok) void response.body?.cancel().catch(() => undefined);
    if (response.status >= 500 || response.status === 429) {
      throw new PaymentGatewayError(`PSP responded ${String(response.status)}`, true, {
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), new Date()),
      });
    }
    if (!response.ok) {
      throw new PaymentGatewayError(`PSP rejected the request (${String(response.status)})`, false);
    }
    return response;
  }

  private observe(operation: string, status: number | 'no_answer', startedAt: number): void {
    this.duration.observe({ vendor: VENDOR, operation, status }, secondsSince(startedAt));
  }

  private async send(
    path: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const correlationId = this.correlation.current();
    try {
      return await fetch(new URL(path, this.config.pspBaseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(correlationId === undefined ? {} : { [CORRELATION_HEADER]: correlationId }),
          ...headers,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err: unknown) {
      // timeout (AbortSignal) or network failure: both transient
      throw new PaymentGatewayError('PSP unreachable or timed out', true, { cause: err });
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (err: unknown) {
      // Unparsable JSON is the PSP's bug: a retry gets the same answer. Anything else is the
      // body cut off by the timeout (the signal also covers the body) or by the network.
      const malformed = err instanceof SyntaxError;
      throw new PaymentGatewayError(
        malformed ? 'PSP returned a malformed body' : 'PSP body timed out or was cut off',
        !malformed,
        { cause: err },
      );
    }
  }
}
