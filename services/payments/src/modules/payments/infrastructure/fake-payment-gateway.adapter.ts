import { Injectable } from '@nestjs/common';

import type { ChargeRequest, ChargeResult, PaymentGateway } from '../ports/payment-gateway.port';

/**
 * Deterministic, in-process gateway (`PAYMENT_GATEWAY=fake`): no network, idempotent by key.
 * Amounts ending in 13 minor units are declined, so a decline can be produced on purpose.
 * The default of local development; the e2e suite scripts outcomes with test/doubles/test-psp.ts
 * instead, and the adapter spec runs this one through the same cases as the HTTP adapter.
 */
@Injectable()
export class FakePaymentGateway implements PaymentGateway {
  private readonly results = new Map<string, ChargeResult>();

  charge(request: ChargeRequest): Promise<ChargeResult> {
    const existing = this.results.get(request.idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const chargeId = `fake_${request.idempotencyKey}`;
    const result: ChargeResult =
      request.amount.amountMinor % 100n === 13n
        ? { status: 'declined', chargeId, declineCode: 'card_declined' }
        : { status: 'succeeded', chargeId };
    this.results.set(request.idempotencyKey, result);
    return Promise.resolve(result);
  }

  /** Nothing to take back: no money moved. */
  void(): Promise<void> {
    return Promise.resolve();
  }
}
