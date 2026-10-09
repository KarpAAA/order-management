import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import type { DbTransactionAdapter } from '@infra/database/transactional.adapter';

import { NotificationMapper } from './notification.mapper';

import type { Notification } from '../domain/notification';
import type { NotificationsRepositoryPort } from '../ports/notifications-repository.port';

/**
 * Notifications through `txHost.tx`, which joins the transaction of the use case. The
 * dispatcher's read is across workspaces by nature: it sends whatever is due, and the
 * tenant is a column here (docs/adr/0019-notifications-service.md).
 */
@Injectable()
export class NotificationsRepository implements NotificationsRepositoryPort {
  constructor(private readonly txHost: TransactionHost<DbTransactionAdapter>) {}

  /** `ON CONFLICT DO NOTHING`: the fact is already owed, and the transaction goes on. */
  async insertIfAbsent(notification: Notification): Promise<boolean> {
    const { count } = await this.txHost.tx.notification.createMany({
      data: [NotificationMapper.toCreate(notification)],
      skipDuplicates: true,
    });
    return count === 1;
  }

  /**
   * `FOR UPDATE SKIP LOCKED`: a row another dispatcher is sending is passed over, not waited
   * for, so several processes share the work without sending anything twice.
   */
  async lockNextDue(now: Date): Promise<Notification | null> {
    const [due] = await this.txHost.tx.$queryRaw<{ id: string }[]>`
      SELECT id
        FROM notifications
       WHERE status = 'PENDING' AND next_attempt_at <= ${now}
       ORDER BY next_attempt_at
       LIMIT 1
         FOR UPDATE SKIP LOCKED`;
    if (!due) return null;
    const row = await this.txHost.tx.notification.findUniqueOrThrow({ where: { id: due.id } });
    return NotificationMapper.toDomain(row);
  }

  /** No version: the row is held by the lock of `lockNextDue()` until this transaction ends. */
  async save(notification: Notification): Promise<void> {
    await this.txHost.tx.notification.update({
      where: { id: notification.id },
      data: NotificationMapper.toUpdate(notification),
    });
  }
}
