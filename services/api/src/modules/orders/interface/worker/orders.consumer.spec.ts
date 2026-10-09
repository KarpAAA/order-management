import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrdersConsumer } from './orders.consumer';

import type { MaintainOrderEventPartitionsJob } from './maintain-order-event-partitions.job';
import type { Job } from 'bullmq';

const CRON_JOB = 'cron:maintain-order-event-partitions';

const fakeJob = (overrides: Partial<Job> = {}): Job =>
  ({
    id: 'tick-1',
    name: CRON_JOB,
    data: {},
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...overrides,
  }) as Job;

/** The consumer with the cron job replaced by `run`. */
const consumerWith = (run: MaintainOrderEventPartitionsJob['run'] = vi.fn()): OrdersConsumer =>
  new OrdersConsumer({ run } as MaintainOrderEventPartitionsJob, { concurrency: 1 });

describe('OrdersConsumer routing (transport/queues.md §3)', () => {
  it('runs the partition maintenance job on its cron tick', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    await consumerWith(run).process(fakeJob());

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lets a failed maintenance run fail the job, so BullMQ retries it', async () => {
    const error = new Error('database is down');

    await expect(consumerWith(vi.fn().mockRejectedValue(error)).process(fakeJob())).rejects.toBe(
      error,
    );
  });

  it.each(['expire-order', 'charge-order'])('fails the unknown job %s for good', async (name) => {
    const run = vi.fn();

    await expect(consumerWith(run).process(fakeJob({ name }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe('OrdersConsumer dead jobs (dlq: alert, transport/queues.md §4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['all attempts spent', fakeJob({ attemptsMade: 3 }), new Error('database is down')],
    [
      'failed by UnrecoverableError after one attempt',
      fakeJob({ attemptsMade: 1 }),
      new UnrecoverableError('unknown job'),
    ],
  ])('alerts on a job %s', (_case, job, err) => {
    const alert = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    consumerWith().onFailed(job, err);

    expect(alert).toHaveBeenCalledWith(expect.stringContaining(`dead job ${CRON_JOB}`));
  });

  it('stays quiet on an attempt that BullMQ will retry', () => {
    const alert = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    consumerWith().onFailed(fakeJob({ attemptsMade: 2 }), new Error('database is down'));

    expect(alert).not.toHaveBeenCalled();
  });
});
