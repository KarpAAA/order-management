import type {
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../../ports/payment-charge-scheduler.port';

/** Spy: records the charges the use case asked for. Scheduling leaves no state to read back. */
export class RecordingChargeScheduler implements PaymentChargeScheduler {
  readonly scheduled: ScheduledCharge[] = [];

  schedule(charge: ScheduledCharge): Promise<void> {
    this.scheduled.push(charge);
    return Promise.resolve();
  }
}
