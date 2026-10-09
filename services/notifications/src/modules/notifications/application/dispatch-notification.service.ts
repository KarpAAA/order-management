import { Inject, Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';

import { MailDeliveryError, MAILER, type Mailer } from '../ports/mailer.port';
import {
  NOTIFICATIONS_REPOSITORY,
  type NotificationsRepositoryPort,
} from '../ports/notifications-repository.port';

import { DELIVERY_POLICY } from './notification-commands';
import { NotificationsPolicy } from './notifications.policy';

import type { DeliveryPolicy, DispatchOutcome } from './notification-commands';
import type { Notification } from '../domain/notification';
import type { TransactionalAdapter } from '@nestjs-cls/transactional';

/**
 * Above the time one mail may take: the server is given `SMTP_TIMEOUT_MS` (10 s at most) to
 * connect, to greet and between two answers. A transaction that outlives its timeout is
 * rolled back, and the mail it sent meanwhile would go again.
 */
const TRANSACTION_TIMEOUT_MS = 45_000;

/** The one option this use case sets; the adapter of the database knows the rest. */
type WithTimeout = TransactionalAdapter<unknown, unknown, { timeout?: number }>;

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Sends one notification that is due, and records how it went, in one transaction that
 * holds the row: another dispatcher skips it, and a process that dies gives it back.
 *
 * The mail server is called inside the transaction, on purpose. The alternative, to mark the
 * row first and send afterwards, loses the mail when the process dies in between; this
 * order sends it twice instead, and only when the process dies between the server's answer
 * and the commit. A mail has no way to be sent exactly once: the server keeps no key
 * (docs/adr/0019-notifications-service.md).
 *
 * A try that fails is not an error of the use case: it is recorded, and the next one is due
 * later, or the notification is given up and somebody is told.
 */
@Injectable()
export class DispatchNotificationService {
  private readonly logger = new Logger(DispatchNotificationService.name);

  constructor(
    @Inject(NOTIFICATIONS_REPOSITORY) private readonly notifications: NotificationsRepositoryPort,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly policy: NotificationsPolicy,
    private readonly clock: Clock,
    @Inject(DELIVERY_POLICY) private readonly delivery: DeliveryPolicy,
  ) {}

  @Transactional<WithTimeout>({ timeout: TRANSACTION_TIMEOUT_MS })
  async execute(actor: Actor): Promise<DispatchOutcome> {
    this.policy.assertCanDispatch(actor);
    const notification = await this.notifications.lockNextDue(this.clock.now());
    if (!notification) return 'idle';

    const outcome = await this.send(notification);
    await this.notifications.save(notification);
    return outcome;
  }

  private async send(notification: Notification): Promise<DispatchOutcome> {
    try {
      await this.mailer.send({
        to: notification.recipient.email,
        subject: notification.subject,
        text: notification.body,
        messageId: `<${notification.id}@notifications.oms>`,
      });
    } catch (err: unknown) {
      return this.failed(notification, err);
    }
    notification.markSent(this.clock.now());
    return 'sent';
  }

  private failed(notification: Notification, err: unknown): DispatchOutcome {
    notification.markSendFailed({
      error: describe(err),
      // the server answered, and the answer was no; anything else may pass
      permanent: err instanceof MailDeliveryError && !err.retryable,
      now: this.clock.now(),
      policy: this.delivery,
    });
    if (!notification.givenUp) return 'postponed';

    const { id, kind, orderId } = notification;
    this.logger.error(
      `notification ${id} (${kind} of order ${orderId}) given up, its mail was not sent: ${describe(err)}`,
    );
    return 'given-up';
  }
}
