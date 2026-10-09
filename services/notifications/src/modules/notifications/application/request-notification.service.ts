import { Inject, Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';

import { Notification } from '../domain/notification';
import {
  NOTIFICATIONS_REPOSITORY,
  type NotificationsRepositoryPort,
} from '../ports/notifications-repository.port';

import { NotificationsPolicy } from './notifications.policy';

import type { RequestNotificationCommand } from './notification-commands';

/**
 * An event about an order arrived: the service now owes its user a mail. Nothing is sent
 * here. The notification is a row, written in the transaction the consumer opened to record
 * the event (the inbox), so the two exist together or not at all; the dispatcher sends it
 * afterwards (docs/adr/0019-notifications-service.md).
 *
 * A notification about the same fact that is already there is left alone: the user is told
 * once, whichever message said it first.
 */
@Injectable()
export class RequestNotificationService {
  private readonly logger = new Logger(RequestNotificationService.name);

  constructor(
    @Inject(NOTIFICATIONS_REPOSITORY) private readonly notifications: NotificationsRepositoryPort,
    private readonly policy: NotificationsPolicy,
    private readonly clock: Clock,
  ) {}

  @Transactional()
  async execute(cmd: RequestNotificationCommand, actor: Actor): Promise<void> {
    this.policy.assertCanRequest(actor);
    const notification = Notification.request({ ...cmd, now: this.clock.now() });

    const written = await this.notifications.insertIfAbsent(notification);
    if (!written) {
      const { orderId, kind, attempt } = notification;
      this.logger.log(`${kind} of order ${orderId}, attempt ${attempt}: already owed, skipped`);
    }
  }
}
