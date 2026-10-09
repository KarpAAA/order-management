import { Inject, Injectable, Logger } from '@nestjs/common';

import { idempotencyConfig, type IdempotencyConfig } from '@config/configuration';
import { Clock } from '@shared/domain/clock';

import { IdempotencyCleanup } from './idempotency-cleanup';

import type { IdempotencyCronJobName } from './idempotency.queue';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly: deletes the keys recorded before the retention. One unit of work
 * (transport/cron.md §1). `run()` has no trigger of its own: the worker module registers the
 * schedule, the consumer calls it.
 */
@Injectable()
export class CleanupIdempotencyKeysJob {
  static readonly NAME = 'cleanup-idempotency-keys';
  static readonly QUEUE_JOB = 'cron:cleanup-idempotency-keys' satisfies IdempotencyCronJobName;
  // every hour: the retention is counted in hours, and a missed run only keeps keys longer
  static readonly SCHEDULE = '20 * * * *';

  private readonly logger = new Logger(CleanupIdempotencyKeysJob.name);

  constructor(
    private readonly cleanup: IdempotencyCleanup,
    private readonly clock: Clock,
    @Inject(idempotencyConfig.KEY) private readonly config: IdempotencyConfig,
  ) {}

  async run(): Promise<void> {
    const job = CleanupIdempotencyKeysJob.NAME;
    const startedAt = performance.now();
    this.logger.log(`${job} started`);
    try {
      const cutoff = new Date(this.clock.now().getTime() - this.config.retentionHours * HOUR_MS);
      const deleted = await this.cleanup.deleteCreatedBefore(cutoff);
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
