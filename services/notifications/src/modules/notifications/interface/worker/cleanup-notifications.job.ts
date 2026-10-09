import { Inject, Injectable, Logger } from '@nestjs/common';

import { notificationsConfig, type NotificationsConfig } from '@config/configuration';
import { Clock } from '@shared/domain/clock';

import { NotificationsCleanup } from '../../infrastructure/notifications-cleanup';

import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes the notifications sent or given up before the retention, at boot and then every
 * `NOTIFICATIONS_CLEANUP_INTERVAL_MS`. A timer of the process, like the cleanup of the inbox:
 * the service has no queue and no Redis (`cron: none`). Several replicas each run it: the
 * statement is idempotent, the second one finds nothing.
 * Starts on its own, so it is provided by the worker module only (principles #12).
 */
@Injectable()
export class CleanupNotificationsJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CleanupNotificationsJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly cleanup: NotificationsCleanup,
    private readonly clock: Clock,
    @Inject(notificationsConfig.KEY) private readonly config: NotificationsConfig,
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
      const deleted = await this.cleanup.deleteSettledBefore(cutoff);
      if (deleted > 0) this.logger.log(`notifications cleanup: deleted=${String(deleted)}`);
    } catch (err: unknown) {
      this.logger.error(
        `notifications cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
