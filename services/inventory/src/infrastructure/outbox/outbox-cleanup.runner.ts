import { Inject, Injectable } from '@nestjs/common';

import { outboxConfig, type OutboxConfig } from '@config/configuration';
import { Clock } from '@shared/domain/clock';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { OutboxCleanup } from './outbox-cleanup';

import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes the published messages older than the retention, at boot and then every
 * `OUTBOX_CLEANUP_INTERVAL_MS`. A timer of the process, not a scheduled job: the service has
 * no queue and no Redis, and one `DELETE` is not a reason to get them (`cron: none`).
 * Several replicas each run it: the statement is idempotent, the second one finds nothing.
 * Starts on its own, so it is provided by the worker module only (principles #12).
 */
@Injectable()
export class OutboxCleanupRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log: Logger;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly cleanup: OutboxCleanup,
    private readonly clock: Clock,
    @Inject(outboxConfig.KEY) private readonly config: OutboxConfig,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: OutboxCleanupRunner.name });
  }

  onApplicationBootstrap(): void {
    this.running = this.run();
    this.timer = setInterval(() => {
      this.running = this.run();
    }, this.config.cleanupIntervalMs);
    // the process may exit while the timer waits
    this.timer.unref();
  }

  /** Waits for the delete under way: it ends before the database client closes. */
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Never throws: a failed run is logged, and the next interval tries again. */
  async run(): Promise<void> {
    try {
      const cutoff = new Date(this.clock.now().getTime() - this.config.retentionDays * DAY_MS);
      const deleted = await this.cleanup.deletePublishedBefore(cutoff);
      if (deleted > 0) this.log.info({ deleted }, 'outbox cleanup done');
    } catch (err: unknown) {
      this.log.error({ err }, 'outbox cleanup failed');
    }
  }
}
