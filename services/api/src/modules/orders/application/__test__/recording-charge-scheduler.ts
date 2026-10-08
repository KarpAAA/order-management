import type {
  PaymentAttemptRef,
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../../ports/payment-charge-scheduler.port';

/** Spy: records what the use case asked of payments. Asking leaves no state to read back. */
export class RecordingChargeScheduler implements PaymentChargeScheduler {
  readonly scheduled: ScheduledCharge[] = [];
  readonly cancelled: PaymentAttemptRef[] = [];

  schedule(charge: ScheduledCharge): Promise<void> {
    this.scheduled.push(charge);
    return Promise.resolve();
  }

  cancel(attempt: PaymentAttemptRef): Promise<void> {
    this.cancelled.push(attempt);
    return Promise.resolve();
  }
}
