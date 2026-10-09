import { Inject, Injectable, Logger } from '@nestjs/common';

import { inboxConfig, type InboxConfig } from '@config/configuration';
import { Clock } from '@shared/domain/clock';

import { InboxCleanup } from './inbox-cleanup';

import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes the rows of the messages handled before the retention, at boot and then every
 * `INBOX_CLEANUP_INTERVAL_MS`. A timer of the process: the
 * service has no queue and no Redis (`cron: none`). Several replicas each run it: the
 * statement is idempotent, the second one finds nothing.
 * Starts on its own, so it is provided by the worker module only (principles #12).
 */
@Injectable()
export class InboxCleanupRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InboxCleanupRunner.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly cleanup: InboxCleanup,
    private readonly clock: Clock,
    @Inject(inboxConfig.KEY) private readonly config: InboxConfig,
  ) {}

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
      const deleted = await this.cleanup.deleteProcessedBefore(cutoff);
      if (deleted > 0) this.logger.log(`inbox cleanup: deleted=${String(deleted)}`);
    } catch (err: unknown) {
      this.logger.error(
        `inbox cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
