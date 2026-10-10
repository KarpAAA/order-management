import { Inject, Injectable } from '@nestjs/common';

import { idempotencyConfig, type IdempotencyConfig } from '@config/configuration';
import { Clock } from '@shared/domain/clock';
import { LOGGER, type Logger } from '@shared/logger/logger';

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

  private readonly log: Logger;

  constructor(
    private readonly cleanup: IdempotencyCleanup,
    private readonly clock: Clock,
    @Inject(idempotencyConfig.KEY) private readonly config: IdempotencyConfig,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: CleanupIdempotencyKeysJob.name });
  }

  async run(): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - this.config.retentionHours * HOUR_MS);
    const deleted = await this.cleanup.deleteCreatedBefore(cutoff);
    // the line of the run (how long, whether it failed) is written by JobScope
    this.log.info({ job: CleanupIdempotencyKeysJob.NAME, deleted }, 'cleanup done');
  }
}
