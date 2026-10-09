import { describe, expect, it } from 'vitest';

import {
  ALL_NOTICES,
  LATER,
  NOTICES,
  NOW,
  OCCURRED,
  ORDER,
  POLICY,
  RECIPIENT,
  requested,
  settled,
  WORKSPACE,
} from './__test__/builders';
import { NotificationNotPendingError } from './errors';
import { NotificationStatus } from './notification-status';
import { render } from './templates';

const failure = (overrides: { permanent?: boolean; now?: Date } = {}) => ({
  error: 'Error: connect ECONNREFUSED',
  permanent: false,
  now: LATER,
  policy: POLICY,
  ...overrides,
});

describe('Notification.request', () => {
  it('NTF-001 is owed at once: PENDING, due now, not tried yet', () => {
    expect(requested().snapshot()).toMatchObject({
      status: NotificationStatus.Pending,
      nextAttemptAt: NOW,
      sendAttempts: 0,
      lastError: null,
      settledAt: null,
      createdAt: NOW,
    });
  });

  it('NTF-001 NTF-020 is for the recipient of the event, in the workspace of the event', () => {
    expect(requested().snapshot()).toMatchObject({
      workspaceId: WORKSPACE,
      orderId: ORDER,
      recipient: RECIPIENT,
    });
  });

  it.each(ALL_NOTICES)('NTF-001 $kind: carries the mail of its notice', (notice) => {
    const snapshot = requested(notice).snapshot();

    expect(snapshot.kind).toBe(notice.kind);
    expect({ subject: snapshot.subject, body: snapshot.body }).toEqual(render(notice));
  });

  it('NTF-002 keeps when the fact happened, not when its event arrived', () => {
    expect(requested().snapshot().occurredAt).toBe(OCCURRED);
  });

  it.each([NOTICES.placed, NOTICES.paid, NOTICES.paymentFailed, NOTICES.returnedToDraft])(
    'NTF-004 $kind is about the payment attempt of its event',
    (notice) => {
      expect(requested({ ...notice, paymentAttempt: 3 }).attempt).toBe(3);
    },
  );

  it.each([NOTICES.cancelled, NOTICES.fulfilled])(
    'NTF-004 $kind happens to an order once: attempt 0',
    (notice) => {
      expect(requested(notice).attempt).toBe(0);
    },
  );

  it('gives every notification its own id', () => {
    expect(requested().id).not.toBe(requested().id);
  });

  it('does not share the recipient with whoever asked', () => {
    const notification = requested();

    expect(notification.snapshot().recipient).not.toBe(RECIPIENT);
  });
});

describe('Notification.markSent', () => {
  it('NTF-010 PENDING → SENT, with the moment, the try counted and nothing due any more', () => {
    const notification = requested();

    notification.markSent(LATER);

    expect(notification.snapshot()).toMatchObject({
      status: NotificationStatus.Sent,
      settledAt: LATER,
      sendAttempts: 1,
      nextAttemptAt: null,
    });
    expect(notification.givenUp).toBe(false);
  });

  it('NTF-010 counts the tries that failed before it', () => {
    const notification = requested();
    notification.markSendFailed(failure());

    notification.markSent(LATER);

    expect(notification.snapshot()).toMatchObject({ sendAttempts: 2, settledAt: LATER });
  });

  it.each([NotificationStatus.Sent, NotificationStatus.Failed] as const)(
    'NTF-012 a %s notification is not sent again',
    (status) => {
      const notification = settled(status);
      const before = notification.snapshot();

      expect(() => {
        notification.markSent(LATER);
      }).toThrow(NotificationNotPendingError);
      expect(notification.snapshot()).toEqual(before);
    },
  );
});

describe('Notification.markSendFailed', () => {
  it('NTF-011 stays PENDING with the reason, due again after the delay', () => {
    const notification = requested();

    notification.markSendFailed(failure());

    expect(notification.snapshot()).toMatchObject({
      status: NotificationStatus.Pending,
      sendAttempts: 1,
      lastError: 'Error: connect ECONNREFUSED',
      nextAttemptAt: new Date(LATER.getTime() + 1000),
      settledAt: null,
    });
    expect(notification.givenUp).toBe(false);
  });

  it('NTF-011 waits twice as long after every next failure', () => {
    const notification = requested();
    notification.markSendFailed(failure());

    notification.markSendFailed(failure());

    expect(notification.snapshot().nextAttemptAt).toEqual(new Date(LATER.getTime() + 2000));
  });

  it('NTF-012 the last try that fails gives the notification up: FAILED, nothing due', () => {
    const notification = requested();
    notification.markSendFailed(failure());
    notification.markSendFailed(failure());

    notification.markSendFailed(failure());

    expect(notification.snapshot()).toMatchObject({
      status: NotificationStatus.Failed,
      sendAttempts: 3,
      nextAttemptAt: null,
      settledAt: LATER,
      lastError: 'Error: connect ECONNREFUSED',
    });
    expect(notification.givenUp).toBe(true);
  });

  it('NTF-012 with one try allowed, the first failure is the last', () => {
    const notification = requested();

    notification.markSendFailed({ ...failure(), policy: { ...POLICY, maxSendAttempts: 1 } });

    expect(notification.status).toBe(NotificationStatus.Failed);
  });

  it('NTF-013 a refusal for good gives it up on the first try', () => {
    const notification = requested();

    notification.markSendFailed(failure({ permanent: true }));

    expect(notification.snapshot()).toMatchObject({
      status: NotificationStatus.Failed,
      sendAttempts: 1,
      nextAttemptAt: null,
      settledAt: LATER,
    });
  });

  it.each([NotificationStatus.Sent, NotificationStatus.Failed] as const)(
    'NTF-012 a %s notification has no try left to fail',
    (status) => {
      const notification = settled(status);
      const before = notification.snapshot();

      expect(() => {
        notification.markSendFailed(failure());
      }).toThrow(NotificationNotPendingError);
      expect(notification.snapshot()).toEqual(before);
    },
  );
});
