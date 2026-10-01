// order_events partitions against Postgres (OPS-005, OPS-006): the routing of a row to the
// partition of its month, the refusal of a month without one, and the DDL of the adapter.
// The subject is the table's structure and raw DDL: no request reaches either.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@shared/domain/id';
import { addMonths, yearMonthOf } from '@shared/domain/year-month';
import type { YearMonth } from '@shared/domain/year-month';

import { OrderStatus } from '@modules/orders/domain/order-status';
import { partitionName } from '@modules/orders/infrastructure/order-event-partitions.sql';
import { PostgresOrderEventPartitions } from '@modules/orders/infrastructure/postgres-order-event-partitions.adapter';

import { orderFactory } from '../factories';
import { createIntModule, type IntModule } from '../helpers/int-module';
import { USER_ACME_MEMBER } from '../seed/ids';
import { testDb } from '../setup/db';

let app: IntModule;
let partitions: PostgresOrderEventPartitions;

beforeAll(async () => {
  app = await createIntModule({ providers: [PostgresOrderEventPartitions] });
  partitions = app.get(PostgresOrderEventPartitions);
});
afterAll(() => app.close());

// far from the months the migration creates, so a test owns the partitions it touches
const MAY_2031: YearMonth = { year: 2031, month: 5 };
const JUNE_2031: YearMonth = { year: 2031, month: 6 };

const has = async (month: YearMonth): Promise<boolean> =>
  (await partitions.list()).some((m) => m.year === month.year && m.month === month.month);

/** One more history row of `orderId`, dated `at`, written as the repository writes it. */
function addEvent(orderId: string, workspaceId: string, at: Date): Promise<unknown> {
  return testDb().orderEvent.create({
    data: {
      workspaceId,
      id: newId(),
      orderId,
      type: 'ORDER_CANCELLED',
      fromStatus: 'DRAFT',
      toStatus: 'CANCELLED',
      actor: USER_ACME_MEMBER,
      createdAt: at,
    },
  });
}

const partitionOf = async (orderId: string): Promise<string[]> => {
  const rows = await testDb().$queryRaw<{ partition: string }[]>`
    SELECT tableoid::regclass::text AS partition FROM order_events
     WHERE order_id = ${orderId}::uuid ORDER BY created_at`;
  return rows.map((row) => row.partition);
};

describe('order_events partitions after the migrations', () => {
  it('has the current month and three months ahead ready', async () => {
    const current = yearMonthOf(new Date());

    for (const ahead of [0, 1, 2, 3]) {
      expect(await has(addMonths(current, ahead))).toBe(true);
    }
  });
});

describe('PostgresOrderEventPartitions', () => {
  afterEach(async () => {
    await partitions.drop(MAY_2031);
    await partitions.drop(JUNE_2031);
  });

  it('creates a partition once; a second create leaves it alone', async () => {
    expect(await has(MAY_2031)).toBe(false);

    await partitions.create(MAY_2031);
    await partitions.create(MAY_2031);

    expect(await has(MAY_2031)).toBe(true);
  });

  it('OPS-005 stores an event in the partition of its month, bounds in UTC', async () => {
    const order = await orderFactory.create({ status: OrderStatus.Draft });
    await partitions.create(MAY_2031);
    await partitions.create(JUNE_2031);

    await addEvent(order.id, order.workspaceId, new Date('2031-05-31T23:59:59.999Z'));
    await addEvent(order.id, order.workspaceId, new Date('2031-06-01T00:00:00.000Z'));

    expect(await partitionOf(order.id)).toEqual([
      partitionName(yearMonthOf(order.snapshot().createdAt)),
      'order_events_2031_05',
      'order_events_2031_06',
    ]);
  });

  it('OPS-005 rejects an event of a month that has no partition', async () => {
    const order = await orderFactory.create({ status: OrderStatus.Draft });

    await expect(
      addEvent(order.id, order.workspaceId, new Date('2035-01-15T00:00:00.000Z')),
    ).rejects.toThrow(/no partition of relation "order_events"/);
  });

  it('OPS-006 drops a month with its events and nothing else; a second drop is a no-op', async () => {
    const order = await orderFactory.create({ status: OrderStatus.Draft });
    await partitions.create(MAY_2031);
    await partitions.create(JUNE_2031);
    await addEvent(order.id, order.workspaceId, new Date('2031-05-10T00:00:00.000Z'));
    await addEvent(order.id, order.workspaceId, new Date('2031-06-10T00:00:00.000Z'));

    await partitions.drop(MAY_2031);
    await partitions.drop(MAY_2031);

    expect(await has(MAY_2031)).toBe(false);
    expect(await has(JUNE_2031)).toBe(true);
    expect(await partitionOf(order.id)).toEqual([
      partitionName(yearMonthOf(order.snapshot().createdAt)),
      'order_events_2031_06',
    ]);
  });

  it('drops a partition that is already detached (a crash between detach and drop)', async () => {
    await partitions.create(MAY_2031);
    await testDb().$executeRawUnsafe(
      'ALTER TABLE "order_events" DETACH PARTITION "order_events_2031_05"',
    );

    await partitions.drop(MAY_2031);

    const [left] = await testDb().$queryRaw<{ name: string | null }[]>`
      SELECT to_regclass('order_events_2031_05')::text AS name`;
    expect(left?.name).toBeNull();
  });
});
