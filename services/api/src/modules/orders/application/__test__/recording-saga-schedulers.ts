import type {
  SagaStepTimeout,
  SagaTimeoutScheduler,
} from '../../ports/saga-timeout-scheduler.port';
import type {
  RequestedReservation,
  ReservationAttempt,
  StockReservationScheduler,
} from '../../ports/stock-reservation-scheduler.port';

/** Spy: records what the use case asked of inventory. Asking leaves no state to read back. */
export class RecordingStockScheduler implements StockReservationScheduler {
  readonly reserved: RequestedReservation[] = [];
  readonly released: ReservationAttempt[] = [];

  reserve(reservation: RequestedReservation): Promise<void> {
    this.reserved.push(reservation);
    return Promise.resolve();
  }

  release(attempt: ReservationAttempt): Promise<void> {
    this.released.push(attempt);
    return Promise.resolve();
  }
}

/** When every timeout of the spy below goes off. */
export const TIMEOUT_AT = new Date('2026-01-15T11:02:00.000Z');

/** Spy: records the timeouts the use case wrote, and gives each the deadline `TIMEOUT_AT`. */
export class RecordingTimeoutScheduler implements SagaTimeoutScheduler {
  readonly scheduled: SagaStepTimeout[] = [];

  schedule(timeout: SagaStepTimeout): Promise<Date> {
    this.scheduled.push(timeout);
    return Promise.resolve(TIMEOUT_AT);
  }
}
