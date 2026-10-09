// The partition maintenance job across the real stack (OPS-001): a worker that boots registers
// the cron scheduler, its first tick runs right away on BullMQ, OrdersConsumer routes it to the
// job, and the use case creates the month that is missing. The cron time itself is not tested.
import { getQueueToken } from '@nestjs/bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addMonths, yearMonthOf } from '@shared/domain/year-month';

import { ORDERS_QUEUE } from '@modules/orders';

import { createApiApp, type ApiApp } from '../helpers/api-app';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

import type { Queue } from 'bullmq';

const CRON_JOB = 'cron:maintain-order-event-partitions';
// .env.test keeps three months ahead: the last one is what a worker that was down would miss
const { year, month } = addMonths(yearMonthOf(new Date()), 3);
const lastMonthAhead = `order_events_${String(year)}_${String(month).padStart(2, '0')}`;

let api: ApiApp;
let worker: WorkerApp | undefined;
let queue: Queue;

beforeAll(async () => {
  api = await createApiApp();
  queue = api.get<Queue>(getQueueToken(ORDERS_QUEUE));
});
afterAll(async () => {
  try {
    await worker?.close();
  } finally {
    await api.close();
  }
});

const exists = async (table: string): Promise<boolean> => {
  const [row] = await testDb().$queryRaw<{ found: boolean }[]>`
    SELECT to_regclass(${table}) IS NOT NULL AS found`;
  return row?.found ?? false;
};

describe('partition maintenance on worker start (OPS-001)', () => {
  it('creates the month ahead that is missing, on the first tick after boot', async () => {
    await testDb().$executeRawUnsafe(`DROP TABLE "${lastMonthAhead}"`);
    expect(await exists(lastMonthAhead)).toBe(false);

    worker = await createWorkerApp();

    const finished = await waitFor(
      async () => (await queue.getJobs(['completed', 'failed'])).filter((j) => j.name === CRON_JOB),
      (jobs) => jobs.length > 0,
      { what: `${CRON_JOB} to finish` },
    );
    expect(await finished[0]?.getState()).toBe('completed');
    expect(await exists(lastMonthAhead)).toBe(true);
  });

  it('keeps one scheduler, with the next tick waiting in the queue', async () => {
    const schedulers = await queue.getJobSchedulers();

    expect(schedulers.map((s) => s.key)).toEqual(['maintain-order-event-partitions']);
    expect(schedulers[0]?.pattern).toBe('0 3 * * *');
  });
});
