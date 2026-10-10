import { Inject, Injectable } from '@nestjs/common';

import { inboxConfig, type InboxConfig } from '@config/configuration';
import { Clock } from '@shared/domain/clock';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { InboxCleanup } from './inbox-cleanup';

import type { InboxCronJobName } from './inbox.queue';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily: deletes the rows of the messages handled before the retention. One unit of work
 * (transport/cron.md §1). `run()` has no trigger of its own: the worker module registers the
 * schedule, the consumer calls it.
 */
@Injectable()
export class CleanupInboxJob {
  static readonly NAME = 'cleanup-inbox';
  static readonly QUEUE_JOB = 'cron:cleanup-inbox' satisfies InboxCronJobName;
  // 03:45 UTC every day: idempotent, and a missed run only leaves the rows one more day
  static readonly SCHEDULE = '45 3 * * *';

  private readonly log: Logger;

  constructor(
    private readonly cleanup: InboxCleanup,
    private readonly clock: Clock,
    @Inject(inboxConfig.KEY) private readonly config: InboxConfig,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: CleanupInboxJob.name });
  }

  async run(): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - this.config.retentionDays * DAY_MS);
    const deleted = await this.cleanup.deleteProcessedBefore(cutoff);
    // the line of the run (how long, whether it failed) is written by JobScope
    this.log.info({ job: CleanupInboxJob.NAME, deleted }, 'cleanup done');
  }
}
