import { beforeEach, describe, expect, it } from 'vitest';

import type { YearMonth } from '@shared/domain/year-month';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { OrderEventPartitionsMissingError } from '../ports/order-event-partitions.port';

import { fixedClock, member, partitionMaintainer, paymentConsumer } from './__test__/fixtures';
import { InMemoryOrderEventPartitions } from './__test__/in-memory-order-event-partitions';
import { MaintainOrderEventPartitionsService } from './maintain-order-event-partitions.service';
import { OrdersPolicy } from './orders.policy';

// fixedClock: 2026-01-15, so January 2026 is the current month.
const ym = (year: number, month: number): YearMonth => ({ year, month });
const keepAll = { monthsAhead: 2, retentionMonths: 0 };

describe('MaintainOrderEventPartitionsService', () => {
  let partitions: InMemoryOrderEventPartitions;
  let maintain: MaintainOrderEventPartitionsService;

  const serviceOn = (existing: readonly YearMonth[]): void => {
    partitions = new InMemoryOrderEventPartitions(existing);
    maintain = new MaintainOrderEventPartitionsService(partitions, new OrdersPolicy(), fixedClock);
  };

  beforeEach(() => {
    serviceOn([ym(2025, 12), ym(2026, 1)]);
  });

  it('OPS-001 creates the missing months up to the look-ahead and leaves the rest alone', async () => {
    const result = await maintain.execute(keepAll, partitionMaintainer);

    expect(partitions.labels()).toEqual(['2025-12', '2026-01', '2026-02', '2026-03']);
    expect(partitions.calls).toEqual(['create 2026-02', 'create 2026-03']);
    expect(result).toEqual({ created: 2, dropped: 0 });
  });

  it('OPS-001 a second run changes nothing', async () => {
    await maintain.execute(keepAll, partitionMaintainer);
    partitions.calls.length = 0;

    const result = await maintain.execute(keepAll, partitionMaintainer);

    expect(partitions.calls).toEqual([]);
    expect(result).toEqual({ created: 0, dropped: 0 });
  });

  it('OPS-002 drops the months past the retention, after the coming months exist', async () => {
    serviceOn([ym(2025, 10), ym(2025, 11), ym(2025, 12), ym(2026, 1)]);

    const result = await maintain.execute(
      { monthsAhead: 1, retentionMonths: 1 },
      partitionMaintainer,
    );

    expect(partitions.labels()).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(partitions.calls).toEqual(['create 2026-02', 'drop 2025-10', 'drop 2025-11']);
    expect(result).toEqual({ created: 1, dropped: 2 });
  });

  it('OPS-002 keeps every month while the retention is off', async () => {
    serviceOn([ym(2020, 1), ym(2026, 1)]);

    await maintain.execute(keepAll, partitionMaintainer);

    expect(partitions.labels()).toContain('2020-01');
  });

  it('OPS-004 fails when a coming month still has no partition, and drops nothing', async () => {
    serviceOn([ym(2025, 10), ym(2026, 1)]);
    partitions.createsNothing();

    const run = maintain.execute({ monthsAhead: 1, retentionMonths: 1 }, partitionMaintainer);

    await expect(run).rejects.toThrow(OrderEventPartitionsMissingError);
    await expect(run).rejects.toMatchObject({ months: [ym(2026, 2)], retryable: true });
    expect(partitions.labels()).toEqual(['2025-10', '2026-01']);
  });

  it.each([
    ['a user', member],
    ['another system actor', paymentConsumer],
  ])('OPS-003 %s cannot run it', async (_case, actor) => {
    await expect(maintain.execute(keepAll, actor)).rejects.toThrow(ForbiddenError);

    expect(partitions.calls).toEqual([]);
  });
});
