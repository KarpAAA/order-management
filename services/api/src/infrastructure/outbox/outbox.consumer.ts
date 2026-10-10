import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { JobScope } from '@common/messaging/job-scope';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { CleanupOutboxJob } from './cleanup-outbox.job';
import { OUTBOX_QUEUE } from './outbox.queue';

import type { Job } from 'bullmq';

/**
 * Thin: route by job name, call one cron job's `run()`. One tick a day, so one at a time.
 * The relay is not a job of this queue: it must keep publishing while Redis is away.
 */
@Processor(OUTBOX_QUEUE, { concurrency: 1 })
export class OutboxConsumer extends WorkerHost {
  private readonly log: Logger;

  constructor(
    private readonly cleanupJob: CleanupOutboxJob,
    private readonly jobs: JobScope,
    @Inject(LOGGER) logger: Logger,
  ) {
    super();
    this.log = logger.child({ context: OutboxConsumer.name });
  }

  process(job: Job): Promise<void> {
    return this.jobs.run(job, () => this.route(job));
  }

  private async route(job: Job): Promise<void> {
    switch (job.name) {
      case CleanupOutboxJob.QUEUE_JOB:
        return this.cleanupJob.run();
      default:
        throw new UnrecoverableError(`unknown job ${job.name}`);
    }
  }

  /** A dead job is a bug: attempts spent, or failed for good (queues.md §4). */
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    const attemptsSpent = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (attemptsSpent || err.name === 'UnrecoverableError') {
      this.log.error({ queue: job.queueName, job: job.name, jobId: job.id, err }, 'dead job');
      this.jobs.died(job);
    }
  }
}
