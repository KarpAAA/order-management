import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { CleanupInboxJob } from './cleanup-inbox.job';
import { INBOX_QUEUE } from './inbox.queue';

import type { Job } from 'bullmq';

/** Thin: route by job name, call one cron job's `run()`. One tick a day, so one at a time. */
@Processor(INBOX_QUEUE, { concurrency: 1 })
export class InboxConsumer extends WorkerHost {
  private readonly logger = new Logger(InboxConsumer.name);

  constructor(private readonly cleanupJob: CleanupInboxJob) {
    super();
  }

  async process(job: Job): Promise<void> {
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
      this.logger.error(`dead job ${job.name} id=${job.id ?? ''}: ${err.message}`);
    }
  }
}
