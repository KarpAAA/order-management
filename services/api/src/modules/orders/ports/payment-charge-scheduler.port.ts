import type { Money } from '@shared/domain/money';

export const PAYMENT_CHARGE_SCHEDULER = Symbol('PAYMENT_CHARGE_SCHEDULER');

export interface ScheduledCharge {
  workspaceId: string;
  orderId: string;
  paymentAttempt: number;
  /** What to charge: payments-service cannot read the order. */
  amount: Money;
}

/**
 * "Charge this attempt, and tell me how it ended." The charge happens in payments-service;
 * the answer comes back as an event (`interface/worker/payment-events.consumer.ts`).
 *
 * Called inside the transaction of the use case, and that is the contract of this port: the
 * request is recorded with the change that needs it (an outbox row), never sent to the
 * outside from here. An adapter that calls a broker or an HTTP API does not belong behind it.
 */
export interface PaymentChargeScheduler {
  schedule(charge: ScheduledCharge): Promise<void>;
}
