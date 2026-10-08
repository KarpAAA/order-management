import { Inject, Injectable, Logger } from '@nestjs/common';

import { outboxConfig, type OutboxConfig } from '@config/configuration';
import { Clock } from '@shared/domain/clock';

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

  private readonly logger = new Logger(CleanupOutboxJob.name);

  constructor(
    private readonly cleanup: OutboxCleanup,
    private readonly clock: Clock,
    @Inject(outboxConfig.KEY) private readonly config: OutboxConfig,
  ) {}

  async run(): Promise<void> {
    const job = CleanupOutboxJob.NAME;
    const startedAt = performance.now();
    this.logger.log(`${job} started`);
    try {
      const cutoff = new Date(this.clock.now().getTime() - this.config.retentionDays * DAY_MS);
      const deleted = await this.cleanup.deletePublishedBefore(cutoff);
      this.logger.log(
        `${job} finished: deleted=${String(deleted)} ` +
          `durationMs=${String(Math.round(performance.now() - startedAt))}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `${job} failed after ${String(Math.round(performance.now() - startedAt))} ms: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      throw err; // the queue retries; the consumer alerts on a dead job
    }
  }
}
