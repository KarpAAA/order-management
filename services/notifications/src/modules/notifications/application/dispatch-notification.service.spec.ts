import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@shared/errors/forbidden-error';

import {
  CORRELATION_ID,
  LATER,
  notificationWith,
  NOTICES,
  NOW,
  POLICY,
  RECIPIENT,
  requested,
  settled,
} from '../domain/__test__/builders';
import { NotificationStatus } from '../domain/notification-status';
import { MailDeliveryError } from '../ports/mailer.port';

import { consumer, dispatcher, enableNoOpTransactions, fixedClock } from './__test__/fixtures';
import { InMemoryNotificationsRepository } from './__test__/in-memory-notifications.repository';
import { RecordingMailer } from './__test__/recording-mailer';
import { DispatchNotificationService } from './dispatch-notification.service';
import { NotificationsPolicy } from './notifications.policy';

const AWAY = new MailDeliveryError('connect ECONNREFUSED 127.0.0.1:1025', true);
const REFUSED = new MailDeliveryError('550 no such user', false);

describe('DispatchNotificationService', () => {
  let notifications: InMemoryNotificationsRepository;
  let mailer: RecordingMailer;
  let service: DispatchNotificationService;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    notifications = new InMemoryNotificationsRepository();
    mailer = new RecordingMailer();
    service = new DispatchNotificationService(
      notifications,
      mailer,
      new NotificationsPolicy(),
      fixedClock,
      POLICY,
    );
  });

  /** One pass: how it went. What it tells its caller besides is asked for by `tried()`. */
  const dispatch = async () => (await service.execute(dispatcher)).outcome;
  const tried = () => service.execute(dispatcher);

  it('NTF-010 hands the due notification to the mail server, as it was written', async () => {
    const notification = requested(NOTICES.paid);
    notifications.put(notification);

    expect(await dispatch()).toBe('sent');

    expect(mailer.sent).toEqual([
      {
        to: RECIPIENT.email,
        subject: notification.subject,
        text: notification.body,
        messageId: `<${notification.id}@notifications.oms>`,
      },
    ]);
  });

  it('NTF-010 records that it was sent, and when', async () => {
    const notification = requested();
    notifications.put(notification);

    await dispatch();

    expect(notifications.get(notification.id).snapshot()).toMatchObject({
      status: NotificationStatus.Sent,
      settledAt: LATER,
      sendAttempts: 1,
      nextAttemptAt: null,
    });
  });

  it('NTF-010 has nothing to do when nothing is owed', async () => {
    expect(await dispatch()).toBe('idle');

    expect(mailer.tried).toEqual([]);
  });

  it('NTF-011 leaves a notification alone until its next try is due', async () => {
    const afterNow = new Date(LATER.getTime() + 1);
    notifications.put(notificationWith({ nextAttemptAt: afterNow, sendAttempts: 1 }));

    expect(await dispatch()).toBe('idle');

    expect(mailer.tried).toEqual([]);
  });

  it.each([NotificationStatus.Sent, NotificationStatus.Failed] as const)(
    'NTF-012 never sends a %s notification again',
    async (status) => {
      notifications.put(settled(status));

      expect(await dispatch()).toBe('idle');

      expect(mailer.tried).toEqual([]);
    },
  );

  it('NTF-010 sends one notification per pass, the one that has waited longest first', async () => {
    const newer = notificationWith({ id: 'newer', orderId: 'order-2', nextAttemptAt: LATER });
    const older = notificationWith({ id: 'older', nextAttemptAt: NOW });
    notifications.put(newer);
    notifications.put(older);

    await dispatch();

    expect(notifications.get('older').status).toBe(NotificationStatus.Sent);
    expect(notifications.get('newer').status).toBe(NotificationStatus.Pending);
  });

  describe('the mail server is away', () => {
    beforeEach(() => {
      mailer.failWith(AWAY);
    });

    it('NTF-011 postpones the notification: still owed, with the reason and the next try', async () => {
      const notification = requested();
      notifications.put(notification);

      expect(await dispatch()).toBe('postponed');

      expect(notifications.get(notification.id).snapshot()).toMatchObject({
        status: NotificationStatus.Pending,
        sendAttempts: 1,
        lastError: `MailDeliveryError: ${AWAY.message}`,
        nextAttemptAt: new Date(LATER.getTime() + POLICY.retryDelayMs),
        settledAt: null,
      });
    });

    it('NTF-012 gives up on the last try, and says so', async () => {
      const notification = notificationWith({ sendAttempts: POLICY.maxSendAttempts - 1 });
      notifications.put(notification);

      expect(await dispatch()).toBe('given-up');

      expect(notifications.get(notification.id).snapshot()).toMatchObject({
        status: NotificationStatus.Failed,
        sendAttempts: POLICY.maxSendAttempts,
        settledAt: LATER,
        nextAttemptAt: null,
      });
    });

    it('NTF-014 does not hold the notifications behind it', async () => {
      const first = notificationWith({ id: 'first', nextAttemptAt: NOW });
      const second = notificationWith({ id: 'second', orderId: 'order-2', nextAttemptAt: LATER });
      notifications.put(first);
      notifications.put(second);
      await dispatch();

      mailer.failWith(undefined);
      // "first" is due again only after its delay: the pass takes "second"
      expect(await dispatch()).toBe('sent');

      expect(notifications.get('second').status).toBe(NotificationStatus.Sent);
      expect(notifications.get('first').status).toBe(NotificationStatus.Pending);
    });

    it('NTF-016 tries again under the same Message-ID', async () => {
      const notification = notificationWith({ nextAttemptAt: NOW });
      notifications.put(notification);
      await dispatch();
      // the wait is over
      notifications.put(
        notificationWith({ ...notifications.get(notification.id).snapshot(), nextAttemptAt: NOW }),
      );

      mailer.failWith(undefined);
      await dispatch();

      expect(mailer.tried.map((mail) => mail.messageId)).toEqual([
        `<${notification.id}@notifications.oms>`,
        `<${notification.id}@notifications.oms>`,
      ]);
    });
  });

  it('NTF-013 gives up at once when the server refuses the mail for good', async () => {
    mailer.failWith(REFUSED);
    const notification = requested();
    notifications.put(notification);

    expect(await dispatch()).toBe('given-up');

    expect(notifications.get(notification.id).snapshot()).toMatchObject({
      status: NotificationStatus.Failed,
      sendAttempts: 1,
      lastError: `MailDeliveryError: ${REFUSED.message}`,
    });
  });

  it('NTF-011 an error the adapter did not name may pass on the next try', async () => {
    mailer.failWith(new TypeError('socket hang up'));
    const notification = requested();
    notifications.put(notification);

    expect(await dispatch()).toBe('postponed');

    expect(notifications.get(notification.id).snapshot()).toMatchObject({
      status: NotificationStatus.Pending,
      lastError: 'TypeError: socket hang up',
    });
  });

  it('NTF-022 only the dispatcher may send', async () => {
    notifications.put(requested());

    await expect(service.execute(consumer)).rejects.toThrow(ForbiddenError);

    expect(mailer.tried).toEqual([]);
  });

  describe('what a pass tells its caller, which logs it (LOG-042)', () => {
    it('names the notification it sent and the chain of its event, never the address', async () => {
      const notification = requested(NOTICES.paid);
      notifications.put(notification);

      const dispatched = await tried();

      expect(dispatched).toEqual({
        outcome: 'sent',
        notification: {
          id: notification.id,
          orderId: notification.orderId,
          kind: 'order-paid',
          attempt: 1,
          sendAttempts: 1,
          correlationId: CORRELATION_ID,
        },
      });
      expect(JSON.stringify(dispatched)).not.toContain(RECIPIENT.email);
    });

    it('says why a try failed with the code of the server, not with its text', async () => {
      mailer.failWith(
        new MailDeliveryError(`550 no such user <${RECIPIENT.email}>`, false, { smtpCode: 550 }),
      );
      notifications.put(requested());

      const dispatched = await tried();

      expect(dispatched).toMatchObject({
        outcome: 'given-up',
        failure: { retryable: false, smtpCode: 550 },
      });
      expect(JSON.stringify(dispatched)).not.toContain(RECIPIENT.email);
    });

    it('says that a failure may pass when the server did not answer', async () => {
      mailer.failWith(AWAY);
      notifications.put(requested());

      expect(await tried()).toMatchObject({ outcome: 'postponed', failure: { retryable: true } });
    });

    it('tells nothing about a pass that found nothing due', async () => {
      expect(await tried()).toEqual({ outcome: 'idle' });
    });
  });
});
