import type { Prisma } from '@infra/database/generated/prisma/client';

import { Notification } from '../domain/notification';

import type { NotificationStatus } from '../domain/notification-status';
import type { NotificationKind } from '../domain/order-notice';

type NotificationRow = Prisma.NotificationGetPayload<object>;

export const NotificationMapper = {
  toDomain(row: NotificationRow): Notification {
    return Notification.restore({
      id: row.id,
      workspaceId: row.workspaceId,
      orderId: row.orderId,
      // written by this service only, from the kinds it knows
      kind: row.kind as NotificationKind,
      attempt: row.attempt,
      recipient: { userId: row.recipientUserId, email: row.recipientEmail },
      subject: row.subject,
      body: row.body,
      status: row.status as NotificationStatus,
      sendAttempts: row.sendAttempts,
      nextAttemptAt: row.nextAttemptAt,
      lastError: row.lastError,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt,
      settledAt: row.settledAt,
    });
  },

  toCreate(notification: Notification): Prisma.NotificationCreateManyInput {
    const { recipient, ...s } = notification.snapshot();
    return { ...s, recipientUserId: recipient.userId, recipientEmail: recipient.email };
  },

  /** What a try changes: who is told what is written once, with the notification. */
  toUpdate(notification: Notification): Prisma.NotificationUncheckedUpdateInput {
    const { status, sendAttempts, nextAttemptAt, lastError, settledAt } = notification.snapshot();
    return { status, sendAttempts, nextAttemptAt, lastError, settledAt };
  },
};
