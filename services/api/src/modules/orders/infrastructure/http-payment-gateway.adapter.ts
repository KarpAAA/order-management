import { Inject, Injectable, Logger } from '@nestjs/common';

import { paymentsConfig, type PaymentsConfig } from '@config/configuration';

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
 * Talks to the PSP (devtools/fake-psp locally) over plain HTTP. No retries here on purpose:
 * the charge job is retried by BullMQ (5 attempts, exponential backoff), and retrying in
 * both places would multiply the calls.
 */
@Injectable()
export class HttpPaymentGateway implements PaymentGateway {
  private readonly logger = new Logger(HttpPaymentGateway.name);

  constructor(@Inject(paymentsConfig.KEY) private readonly config: PaymentsConfig) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const startedAt = performance.now();
    const response = await this.post(request);
    const durationMs = Math.round(performance.now() - startedAt);
    this.logger.log(`psp charge status=${response.status} durationMs=${durationMs}`);

    // 5xx and 429 are transient; any other non-2xx means our request is wrong.
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
