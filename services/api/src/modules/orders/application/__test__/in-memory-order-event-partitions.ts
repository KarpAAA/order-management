import { monthIndex } from '@shared/domain/year-month';
import type { YearMonth } from '@shared/domain/year-month';

import type { OrderEventPartitionsPort } from '../../ports/order-event-partitions.port';

/**
 * Fake: a working `OrderEventPartitionsPort` on a Map. Keeps the port's contract (create and
 * drop are idempotent) and records the calls in order, so a test can assert what ran first.
 */
export class InMemoryOrderEventPartitions implements OrderEventPartitionsPort {
  readonly calls: string[] = [];
  private readonly months = new Map<number, YearMonth>();
  private ignoreCreates = false;

  constructor(existing: readonly YearMonth[] = []) {
    for (const month of existing) this.months.set(monthIndex(month), month);
  }

  list(): Promise<YearMonth[]> {
    return Promise.resolve([...this.months.values()]);
  }

  create(month: YearMonth): Promise<void> {
    this.calls.push(`create ${label(month)}`);
    if (!this.ignoreCreates) this.months.set(monthIndex(month), month);
    return Promise.resolve();
  }

  drop(month: YearMonth): Promise<void> {
    this.calls.push(`drop ${label(month)}`);
    this.months.delete(monthIndex(month));
    return Promise.resolve();
  }

  /** Arrange: `create` reports success and creates nothing (a name taken by another table). */
  createsNothing(): void {
    this.ignoreCreates = true;
  }

  /** Assert: the months that have a partition, oldest first. */
  labels(): string[] {
    return [...this.months.values()]
      .sort((left, right) => monthIndex(left) - monthIndex(right))
      .map(label);
  }
}

const label = (month: YearMonth): string =>
  `${String(month.year)}-${String(month.month).padStart(2, '0')}`;
