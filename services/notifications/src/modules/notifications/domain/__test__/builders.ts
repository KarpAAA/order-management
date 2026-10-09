import { Notification } from '../notification';

import type { DeliveryPolicy, NotificationProps, Recipient } from '../notification';
import type { NotificationStatus } from '../notification-status';
import type { OrderNotice } from '../order-notice';

/** When the fact happened, when its event arrived, and a moment after that. */
export const OCCURRED = new Date('2026-01-15T09:58:00.000Z');
export const NOW = new Date('2026-01-15T10:00:00.000Z');
export const LATER = new Date('2026-01-15T11:00:00.000Z');

export const WORKSPACE = '01950000-0000-7000-8000-00000000a001';
export const OTHER_WORKSPACE = '01950000-0000-7000-8000-00000000a002';
export const ORDER = '01950000-0000-7000-8000-00000000b001';
export const OTHER_ORDER = '01950000-0000-7000-8000-00000000b002';
export const USER = '01950000-0000-7000-8000-00000000c001';

export const RECIPIENT: Recipient = { userId: USER, email: 'buyer@example.com' };
export const AMOUNT = { amountMinor: 12_990, currency: 'EUR' };

/** Three tries, the second one a second after the first. */
export const POLICY: DeliveryPolicy = { maxSendAttempts: 3, retryDelayMs: 1000 };

const about = { orderId: ORDER, occurredAt: OCCURRED };

/** One notice of every kind, about ORDER. */
export const NOTICES = {
  placed: { ...about, kind: 'order-placed', paymentAttempt: 1, amount: AMOUNT },
  paid: { ...about, kind: 'order-paid', paymentAttempt: 1, amount: AMOUNT },
  cancelled: { ...about, kind: 'order-cancelled' },
  fulfilled: { ...about, kind: 'order-fulfilled' },
  paymentFailed: {
    ...about,
    kind: 'order-payment-failed',
    paymentAttempt: 1,
    reason: 'card_declined',
    amount: AMOUNT,
  },
  returnedToDraft: {
    ...about,
    kind: 'order-returned-to-draft',
    paymentAttempt: 1,
    reason: 'out_of_stock',
  },
} as const satisfies Record<string, OrderNotice>;

export const ALL_NOTICES: readonly OrderNotice[] = Object.values(NOTICES);

/** A notification that was just asked for, at NOW. */
export function requested(notice: OrderNotice = NOTICES.paid): Notification {
  return Notification.request({ workspaceId: WORKSPACE, recipient: RECIPIENT, notice, now: NOW });
}

/** A notification as the table holds it; tests override only what they test. */
export function notificationWith(overrides: Partial<NotificationProps> = {}): Notification {
  return Notification.restore({ ...requested().snapshot(), ...overrides });
}

/** Sent or given up at NOW. */
export function settled(status: NotificationStatus.Sent | NotificationStatus.Failed): Notification {
  return notificationWith({ status, sendAttempts: 1, nextAttemptAt: null, settledAt: NOW });
}
