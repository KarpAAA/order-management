import { Prisma } from '@infra/database/generated/prisma/client';
import { traceCarrierFrom, type TraceCarrier } from '@infra/tracing/trace-context';

import { Notification } from '../domain/notification';

import type { NotificationStatus } from '../domain/notification-status';
import type { NotificationKind } from '../domain/order-notice';

type NotificationRow = Prisma.NotificationGetPayload<object>;

/** The trace a row kept, as the plain record the domain hands on. */
const traceOf = (stored: unknown): Record<string, string> | null => {
  const carrier = traceCarrierFrom(stored);
  return carrier ? { ...carrier } : null;
};

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
      correlationId: row.correlationId,
      traceContext: traceOf(row.traceContext),
      createdAt: row.createdAt,
      settledAt: row.settledAt,
    });
  },

  /**
   * The trace is not the notification's to say: the repository names the one the insert is
   * in, and the row keeps it (docs/adr/0025).
   */
  toCreate(
    notification: Notification,
    trace: TraceCarrier | null,
  ): Prisma.NotificationCreateManyInput {
    const { recipient, ...s } = notification.snapshot();
    return {
      ...s,
      recipientUserId: recipient.userId,
      recipientEmail: recipient.email,
      traceContext: trace ? { ...trace } : Prisma.DbNull,
    };
  },

  /** What a try changes: who is told what is written once, with the notification. */
  toUpdate(notification: Notification): Prisma.NotificationUncheckedUpdateInput {
    const { status, sendAttempts, nextAttemptAt, lastError, settledAt } = notification.snapshot();
    return { status, sendAttempts, nextAttemptAt, lastError, settledAt };
  },
};
