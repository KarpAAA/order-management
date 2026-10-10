import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@shared/errors/forbidden-error';
import { silentLogger } from '@shared/logger/silent-logger';

import {
  ALL_NOTICES,
  CORRELATION_ID,
  LATER,
  NOTICES,
  OTHER_ORDER,
  RECIPIENT,
  WORKSPACE,
} from '../domain/__test__/builders';
import { NotificationStatus } from '../domain/notification-status';

import { consumer, dispatcher, enableNoOpTransactions, fixedClock } from './__test__/fixtures';
import { InMemoryNotificationsRepository } from './__test__/in-memory-notifications.repository';
import { NotificationsPolicy } from './notifications.policy';
import { RequestNotificationService } from './request-notification.service';

import type { OrderNotice } from '../domain/order-notice';

describe('RequestNotificationService', () => {
  let notifications: InMemoryNotificationsRepository;
  let service: RequestNotificationService;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    notifications = new InMemoryNotificationsRepository();
    service = new RequestNotificationService(
      notifications,
      new NotificationsPolicy(),
      fixedClock,
      silentLogger,
    );
  });

  const request = (notice: OrderNotice, recipient = RECIPIENT) =>
    service.execute(
      { workspaceId: WORKSPACE, recipient, notice, correlationId: CORRELATION_ID },
      consumer,
    );

  it.each(ALL_NOTICES)(
    'NTF-001 $kind: one notification is owed, and nothing is sent',
    async (n) => {
      await request(n);

      expect(notifications.all().map((row) => row.snapshot())).toEqual([
        expect.objectContaining({
          workspaceId: WORKSPACE,
          // the chain of the event, for the mail that goes out later (LOG-041)
          correlationId: CORRELATION_ID,
          orderId: n.orderId,
          kind: n.kind,
          recipient: RECIPIENT,
          status: NotificationStatus.Pending,
          // due at once: the dispatcher takes it on its next pass
          nextAttemptAt: LATER,
          createdAt: LATER,
          sendAttempts: 0,
        }),
      ]);
    },
  );

  it('NTF-004 another message about the same fact writes nothing, and is not an error', async () => {
    await request(NOTICES.paid);
    const [first] = notifications.all();

    // payments answered a second command: the same order, kind and attempt, another moment
    await request(
      { ...NOTICES.paid, occurredAt: LATER },
      { ...RECIPIENT, email: 'new@example.com' },
    );

    expect(notifications.all()).toHaveLength(1);
    // the user was told what the first message said
    expect(notifications.all()[0]?.snapshot()).toEqual(first?.snapshot());
  });

  it('NTF-004 the next attempt of the order is another fact', async () => {
    await request(NOTICES.paymentFailed);

    await request({ ...NOTICES.paymentFailed, paymentAttempt: 2 });

    expect(notifications.all().map((row) => row.attempt)).toEqual([1, 2]);
  });

  it('NTF-004 the same kind for another order is another fact', async () => {
    await request(NOTICES.cancelled);

    await request({ ...NOTICES.cancelled, orderId: OTHER_ORDER });

    expect(notifications.all()).toHaveLength(2);
  });

  it('NTF-005 owes every notice of an order, in whatever order they come', async () => {
    // a redelivery returned "placed" behind the events published meanwhile
    await request(NOTICES.paid);
    await request(NOTICES.fulfilled);
    await request(NOTICES.placed);

    expect(notifications.all().map((row) => row.kind)).toEqual([
      'order-paid',
      'order-fulfilled',
      'order-placed',
    ]);
  });

  it('NTF-005 a payment that came after a cancellation is told too', async () => {
    await request(NOTICES.cancelled);

    await request(NOTICES.paid);

    expect(notifications.all().map((row) => row.kind)).toEqual(['order-cancelled', 'order-paid']);
  });

  it('NTF-022 only the consumer of the events may ask for a notification', async () => {
    await expect(
      service.execute(
        {
          workspaceId: WORKSPACE,
          recipient: RECIPIENT,
          notice: NOTICES.paid,
          correlationId: CORRELATION_ID,
        },
        dispatcher,
      ),
    ).rejects.toThrow(ForbiddenError);

    expect(notifications.all()).toEqual([]);
  });
});
