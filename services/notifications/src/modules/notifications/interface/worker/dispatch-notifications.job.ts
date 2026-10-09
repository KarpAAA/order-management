import { Inject, Injectable, Logger } from '@nestjs/common';

import { notificationsConfig, type NotificationsConfig } from '@config/configuration';
import { systemActor } from '@shared/auth/actor';

import { DispatchNotificationService } from '../../application/dispatch-notification.service';

import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

const ACTOR = systemActor('dispatcher:notifications');

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Keeps the notifications going out for as long as the process lives: one after the other
 * while something is due, a pause when nothing is. Starts on its own, so it is provided by
 * the worker module only (principles #12).
 *
 * A mail that cannot be sent is the business of its notification, which waits for its next
 * try: the one behind it goes out meanwhile. Only a pass that cannot run at all (the
 * database is away) stops the loop: logged once as an error, quietly retried every
 * interval, and logged again when it recovers. Nothing is lost: the rows wait in the table.
 */
@Injectable()
export class DispatchNotificationsJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DispatchNotificationsJob.name);
  private running: Promise<void> | undefined;
  private stopped = false;
  private stuck = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly dispatch: DispatchNotificationService,
    @Inject(notificationsConfig.KEY) private readonly config: NotificationsConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.dispatchEnabled) {
      this.logger.warn('notifications dispatcher is off: NOTIFICATIONS_DISPATCH_ENABLED=false');
      return;
    }
    this.running = this.run();
  }

  /** Waits for the mail under way: its transaction ends before the database client closes. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const more = await this.once();
      if (!more) await this.pause();
    }
  }

  /** `true`: something was due, so more may be. */
  private async once(): Promise<boolean> {
    try {
      const outcome = await this.dispatch.execute(ACTOR);
      this.recovered();
      return outcome !== 'idle';
    } catch (err: unknown) {
      this.report(err);
      return false;
    }
  }

  private report(error: unknown): void {
    if (this.stuck) return;
    this.stuck = true;
    this.logger.error(
      `notifications dispatcher stuck, mails wait in the table: ${describe(error)}`,
    );
  }

  private recovered(): void {
    if (!this.stuck) return;
    this.stuck = false;
    this.logger.log('notifications dispatcher sends again');
  }

  /** Until the next pass is due, or until the process stops. */
  private pause(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.config.dispatchIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
