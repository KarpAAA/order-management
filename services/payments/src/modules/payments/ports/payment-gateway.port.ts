import type { Money } from '@shared/domain/money';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface ChargeRequest {
  amount: Money;
  /** Our reference for the charge: the order id. */
  reference: string;
  /** Same key → the provider returns the same result and never charges twice. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { status: 'succeeded'; chargeId: string }
  | { status: 'declined'; chargeId: string; declineCode: string };

/**
 * The payment provider, in domain terms. A decline is a result, not an error; transport
 * failures throw `PaymentGatewayError` (an `InfrastructureError` with `retryable`).
 */
export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  /** Takes a charge back. Repeatable: a charge that is already void stays void. */
  void(chargeId: string): Promise<void>;
}
