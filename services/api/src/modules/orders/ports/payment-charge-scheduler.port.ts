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
 * 3.2: a command published to the broker after commit. ROADMAP 3.4: an outbox row written in
 * the same transaction, same port, new adapter.
 */
export interface PaymentChargeScheduler {
  schedule(charge: ScheduledCharge): Promise<void>;
}
