import { Inject, Injectable, Logger } from '@nestjs/common';

import { gatewayConfig, type GatewayConfig } from '@config/configuration';

import { PaymentGatewayError } from './payment-gateway.error';

import type { ChargeRequest, ChargeResult, PaymentGateway } from '../ports/payment-gateway.port';

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
 * Talks to the PSP (devtools/fake-psp locally) over plain HTTP. One call, no retry here: a
 * call that fails and may pass is made again when the command is redelivered
 * (charge-payment.service.ts, docs/adr/0013). Backoff and a circuit breaker around the call
 * itself are ROADMAP 3.11.
 */
@Injectable()
export class HttpPaymentGateway implements PaymentGateway {
  private readonly logger = new Logger(HttpPaymentGateway.name);

  constructor(@Inject(gatewayConfig.KEY) private readonly config: GatewayConfig) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const startedAt = performance.now();
    const response = await this.post(request);
    const durationMs = Math.round(performance.now() - startedAt);
    this.logger.log(`psp charge status=${response.status} durationMs=${durationMs}`);

    // 5xx and 429 are transient; any other non-2xx means our request is wrong. The body is
    // not read there: release it, or the connection stays taken until garbage collection.
    // Not awaited: the error must not wait on the stream.
    if (!response.ok) void response.body?.cancel().catch(() => undefined);
    if (response.status >= 500 || response.status === 429) {
      throw new PaymentGatewayError(`PSP responded ${response.status}`, true);
    }
    if (!response.ok) {
      throw new PaymentGatewayError(`PSP rejected the request (${response.status})`, false);
    }

    const body = await this.readBody(response);
    if (!isPspChargeResponse(body)) {
      throw new PaymentGatewayError('PSP returned an unexpected body', false);
    }
    return body.status === 'succeeded'
      ? { status: 'succeeded', chargeId: body.id }
      : { status: 'declined', chargeId: body.id, declineCode: body.declineCode ?? 'declined' };
  }

  private async post(request: ChargeRequest): Promise<Response> {
    try {
      return await fetch(new URL('/charges', this.config.pspBaseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': request.idempotencyKey,
        },
        body: JSON.stringify({
          amountMinor: Number(request.amount.amountMinor),
          currency: request.amount.currency,
          reference: request.reference,
        }),
        signal: AbortSignal.timeout(this.config.pspTimeoutMs),
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
