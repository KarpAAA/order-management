import { Inject, Injectable } from '@nestjs/common';

import { outboxConfig, type OutboxConfig } from '@config/configuration';
import { Clock } from '@shared/domain/clock';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { OutboxCleanup } from './outbox-cleanup';

import type { OutboxCronJobName } from './outbox.queue';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily: deletes the published messages older than the retention. One unit of work
 * (transport/cron.md §1). `run()` has no trigger of its own: the worker module registers the
 * schedule, the consumer calls it.
 */
@Injectable()
export class CleanupOutboxJob {
  static readonly NAME = 'cleanup-outbox';
  static readonly QUEUE_JOB = 'cron:cleanup-outbox' satisfies OutboxCronJobName;
  // 03:30 UTC every day: idempotent, and a missed run only leaves the rows one more day
  static readonly SCHEDULE = '30 3 * * *';

  private readonly log: Logger;

  constructor(
    private readonly cleanup: OutboxCleanup,
    private readonly clock: Clock,
    @Inject(outboxConfig.KEY) private readonly config: OutboxConfig,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: CleanupOutboxJob.name });
  }

  async run(): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - this.config.retentionDays * DAY_MS);
    const deleted = await this.cleanup.deletePublishedBefore(cutoff);
    // the line of the run (how long, whether it failed) is written by JobScope
    this.log.info({ job: CleanupOutboxJob.NAME, deleted }, 'cleanup done');
  }
}
