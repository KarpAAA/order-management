import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { JobScope } from '@common/messaging/job-scope';
import { RecordingLogger } from '@shared/logger/__test__/recording-logger';

import { OrdersConsumer } from './orders.consumer';

import type { MaintainOrderEventPartitionsJob } from './maintain-order-event-partitions.job';
import type { Job } from 'bullmq';

const CRON_JOB = 'cron:maintain-order-event-partitions';

const fakeJob = (overrides: Partial<Job> = {}): Job =>
  ({
    id: 'tick-1',
    name: CRON_JOB,
    queueName: 'orders',
    data: {},
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...overrides,
  }) as Job;

/** The scope of a job, without its correlation id and its line (`job-scope.spec.ts`). */
const died = vi.fn();
const jobs = {
  run: (_job: Job, work: () => Promise<unknown>) => work(),
  died,
} as unknown as JobScope;

/** The consumer with the cron job replaced by `run`. */
function consumerWith(run: MaintainOrderEventPartitionsJob['run'] = vi.fn()) {
  const logger = new RecordingLogger();
  const consumer = new OrdersConsumer(
    { run } as MaintainOrderEventPartitionsJob,
    { concurrency: 1 },
    jobs,
    logger,
  );
  return { consumer, logger };
}

describe('OrdersConsumer routing (transport/queues.md §3)', () => {
  it('runs the partition maintenance job on its cron tick', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    await consumerWith(run).consumer.process(fakeJob());

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lets a failed maintenance run fail the job, so BullMQ retries it', async () => {
    const error = new Error('database is down');
    const { consumer } = consumerWith(vi.fn().mockRejectedValue(error));

    await expect(consumer.process(fakeJob())).rejects.toBe(error);
  });

  it.each(['expire-order', 'charge-order'])('fails the unknown job %s for good', async (name) => {
    const run = vi.fn();

    await expect(consumerWith(run).consumer.process(fakeJob({ name }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe('OrdersConsumer dead jobs (dlq: alert, transport/queues.md §4)', () => {
  it.each([
    ['all attempts spent', fakeJob({ attemptsMade: 3 }), new Error('database is down')],
    [
      'failed by UnrecoverableError after one attempt',
      fakeJob({ attemptsMade: 1 }),
      new UnrecoverableError('unknown job'),
    ],
  ])('alerts on a job %s, and counts it (MET-012)', (_case, job, err) => {
    const { consumer, logger } = consumerWith();
    died.mockClear();

    consumer.onFailed(job, err);

    expect(died).toHaveBeenCalledExactlyOnceWith(job);
    expect(logger.at('error')).toEqual([
      {
        level: 'error',
        message: 'dead job',
        fields: { context: 'OrdersConsumer', queue: 'orders', job: CRON_JOB, jobId: 'tick-1', err },
      },
    ]);
  });

  it('stays quiet on an attempt that BullMQ will retry', () => {
    const { consumer, logger } = consumerWith();
    died.mockClear();

    consumer.onFailed(fakeJob({ attemptsMade: 2 }), new Error('database is down'));

    expect(logger.lines).toEqual([]);
    expect(died).not.toHaveBeenCalled();
  });
});
