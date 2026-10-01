import type { YearMonth } from '@shared/domain/year-month';
import { InfrastructureError } from '@shared/errors/infrastructure-error';

export const ORDER_EVENT_PARTITIONS = Symbol('ORDER_EVENT_PARTITIONS');

/** The store reported success, yet a month that must have a partition still has none. */
export class OrderEventPartitionsMissingError extends InfrastructureError {
  readonly code = 'ORDER_EVENT_PARTITIONS_MISSING';
  readonly retryable = true;

  constructor(readonly months: readonly YearMonth[]) {
    const names = months.map((m) => `${String(m.year)}-${String(m.month).padStart(2, '0')}`);
    super(`order_events has no partition for ${names.join(', ')}`);
  }
}

/**
 * The monthly partitions of the order history table (`order_events`, RANGE on `created_at`).
 * A month without a partition rejects every write of that month, so they are created ahead.
 */
export interface OrderEventPartitionsPort {
  /** Months that have a partition, in no particular order. */
  list(): Promise<YearMonth[]>;
  /** Idempotent: an existing partition is left alone. */
  create(month: YearMonth): Promise<void>;
  /** Removes the partition with every event of that month. Idempotent. */
  drop(month: YearMonth): Promise<void>;
}
