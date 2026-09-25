export const PAYMENT_CHARGE_SCHEDULER = Symbol('PAYMENT_CHARGE_SCHEDULER');

export interface ScheduledCharge {
  workspaceId: string;
  orderId: string;
  paymentAttempt: number;
}

/**
 * "Charge this attempt later, in the worker." Step 0: a BullMQ job, enqueued after commit.
 * Step 3: an outbox row written in the same transaction — same port, new adapter.
 */
export interface PaymentChargeScheduler {
  schedule(charge: ScheduledCharge): Promise<void>;
}
