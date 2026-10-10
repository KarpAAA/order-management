import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { JobScope } from '@common/messaging/job-scope';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { CleanupInboxJob } from './cleanup-inbox.job';
import { INBOX_QUEUE } from './inbox.queue';

import type { Job } from 'bullmq';

/** Thin: route by job name, call one cron job's `run()`. One tick a day, so one at a time. */
@Processor(INBOX_QUEUE, { concurrency: 1 })
export class InboxConsumer extends WorkerHost {
  private readonly log: Logger;

  constructor(
    private readonly cleanupJob: CleanupInboxJob,
    private readonly jobs: JobScope,
    @Inject(LOGGER) logger: Logger,
  ) {
    super();
    this.log = logger.child({ context: InboxConsumer.name });
  }

  process(job: Job): Promise<void> {
    return this.jobs.run(job, () => this.route(job));
  }

  private async route(job: Job): Promise<void> {
    switch (job.name) {
      case CleanupInboxJob.QUEUE_JOB:
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
    }
  }
}
