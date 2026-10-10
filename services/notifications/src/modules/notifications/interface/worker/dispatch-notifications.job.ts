import { Inject, Injectable } from '@nestjs/common';

import { notificationsConfig, type NotificationsConfig } from '@config/configuration';
import { systemActor } from '@shared/auth/actor';
import { newId } from '@shared/domain/id';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { CORRELATION, type Correlation } from '@shared/messaging/correlation';
import { TRACE_SCOPE, type TraceScope } from '@shared/tracing/trace-scope';

import { DispatchNotificationService } from '../../application/dispatch-notification.service';

import type { Dispatched } from '../../application/notification-commands';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

const ACTOR = systemActor('dispatcher:notifications');

/**
 * Keeps the notifications going out for as long as the process lives: one after the other
 * while something is due, a pause when nothing is. Starts on its own, so it is provided by
 * the worker module only (principles #12).
 *
 * A mail that cannot be sent is the business of its notification, which waits for its next
 * try: the one behind it goes out meanwhile. Only a pass that cannot run at all (the
 * database is away) stops the loop: logged once as an error, quietly retried every
 * interval, and logged again when it recovers. Nothing is lost: the rows wait in the table.
 *
 * The loop has no chain of its own. What it tells about a mail is told in the chain of the
 * event that asked for the notification, kept in its row (docs/adr/0023): the id of the
 * order's request finds the mail too. The same for the trace (docs/adr/0026): the span of
 * the send has ended when the line is written, so the line is written in the trace the row
 * kept. Never the address, and never the text of the server, which names it: the row has
 * both (`last_error`).
 */
@Injectable()
export class DispatchNotificationsJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log: Logger;
  private running: Promise<void> | undefined;
  private stopped = false;
  private stuck = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly dispatch: DispatchNotificationService,
    @Inject(notificationsConfig.KEY) private readonly config: NotificationsConfig,
    @Inject(CORRELATION) private readonly correlation: Correlation,
    @Inject(TRACE_SCOPE) private readonly trace: TraceScope,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: DispatchNotificationsJob.name });
  }

  onApplicationBootstrap(): void {
    if (!this.config.dispatchEnabled) {
      this.log.warn({}, 'notifications dispatcher is off: NOTIFICATIONS_DISPATCH_ENABLED=false');
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
      const dispatched = await this.dispatch.execute(ACTOR);
      this.recovered();
      this.tell(dispatched);
      return dispatched.outcome !== 'idle';
    } catch (err: unknown) {
      this.report(err);
      return false;
    }
  }

  /** The line of one mail, in the chain and in the trace of the event that asked for it. */
  private tell({ outcome, notification, failure }: Dispatched): void {
    if (notification === undefined) return;
    const { id: notificationId, correlationId, traceContext, ...about } = notification;
    this.trace.run(traceContext, () => {
      this.correlation.run(correlationId ?? newId(), () => {
        const fields = { notificationId, ...about, ...failure };
        if (outcome === 'sent') this.log.info(fields, 'mail sent');
        else if (outcome === 'postponed')
          this.log.warn(fields, 'mail not sent, the next try is due later');
        else this.log.error(fields, 'notification given up, its mail was not sent');
      });
    });
  }

  private report(error: unknown): void {
    if (this.stuck) return;
    this.stuck = true;
    this.log.error({ err: error }, 'notifications dispatcher stuck, mails wait in the table');
  }

  private recovered(): void {
    if (!this.stuck) return;
    this.stuck = false;
    this.log.info({}, 'notifications dispatcher sends again');
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
