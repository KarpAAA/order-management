import { describe, expect, it } from 'vitest';

import { change, orderIn } from './__test__/builders';
import { OrderInvalidTransitionError, PaymentAttemptNotPendingError } from './errors';
import { OrderEventType, OrderStatus } from './order-status';

import type { Order } from './order';

/**
 * The whole state machine: every status × every action.
 *
 * The expected table is copied by hand from docs/requirements.md → ORD, on purpose NOT
 * built from `TRANSITIONS`: a test derived from the code it tests would agree with any bug.
 */

type Action = 'place' | 'cancel' | 'fulfill' | 'markPaid' | 'markPaymentFailed';

const ACTIONS: readonly Action[] = ['place', 'cancel', 'fulfill', 'markPaid', 'markPaymentFailed'];

const ALLOWED: readonly { from: OrderStatus; action: Action; to: OrderStatus; recorded: OrderEventType }[] = [
  { from: OrderStatus.Draft, action: 'place', to: OrderStatus.PendingPayment, recorded: OrderEventType.OrderPlaced },
  { from: OrderStatus.Draft, action: 'cancel', to: OrderStatus.Cancelled, recorded: OrderEventType.OrderCancelled },
  { from: OrderStatus.PendingPayment, action: 'markPaid', to: OrderStatus.Paid, recorded: OrderEventType.PaymentSucceeded },
  { from: OrderStatus.PendingPayment, action: 'markPaymentFailed', to: OrderStatus.PaymentFailed, recorded: OrderEventType.PaymentFailed },
  { from: OrderStatus.PaymentFailed, action: 'place', to: OrderStatus.PendingPayment, recorded: OrderEventType.OrderPlaced },
  { from: OrderStatus.PaymentFailed, action: 'cancel', to: OrderStatus.Cancelled, recorded: OrderEventType.OrderCancelled },
  { from: OrderStatus.Paid, action: 'fulfill', to: OrderStatus.Fulfilled, recorded: OrderEventType.OrderFulfilled },
];

const FORBIDDEN = Object.values(OrderStatus).flatMap((from) =>
  ACTIONS.filter((action) => !ALLOWED.some((a) => a.from === from && a.action === action)).map(
    (action) => ({ from, action }),
  ),
);

/** Payment outcomes are guarded by the awaited attempt first (PAY-009); user actions by the table. */
const isPaymentOutcome = (action: Action): boolean =>
  action === 'markPaid' || action === 'markPaymentFailed';

/** Runs `action` the way its caller would; payment outcomes carry the order's current attempt. */
function run(order: Order, action: Action): void {
  switch (action) {
    case 'place':
      order.place(change());
      return;
    case 'cancel':
      order.cancel(change());
      return;
    case 'fulfill':
      order.fulfill(change());
      return;
    case 'markPaid':
      order.markPaid({ ...change(), attempt: order.paymentAttempt, pspChargeId: 'ch_1' });
      return;
    case 'markPaymentFailed':
      order.markPaymentFailed({ ...change(), attempt: order.paymentAttempt, reason: 'card_declined' });
      return;
  }
}

describe('Order state machine', () => {
  it('covers 6 statuses × 5 actions: 7 allowed, 23 forbidden', () => {
    expect(ALLOWED).toHaveLength(7);
    expect(FORBIDDEN).toHaveLength(23);
  });

  it.each(ALLOWED)(
    'ORD allows $action from $from to $to and records $recorded',
    ({ from, action, to, recorded }) => {
      const order = orderIn(from);
      const version = order.version;

      run(order, action);

      expect(order.status).toBe(to);
      expect(order.pullHistory()).toEqual([
        expect.objectContaining({ type: recorded, fromStatus: from, toStatus: to }),
      ]);
      // the repository bumps the version on save; the domain never touches it
      expect(order.version).toBe(version);
    },
  );

  it.each(FORBIDDEN)('ORD-022 rejects $action from $from and changes nothing', ({ from, action }) => {
    const order = orderIn(from);
    const before = order.snapshot();

    expect(() => {
      run(order, action);
    }).toThrow(isPaymentOutcome(action) ? PaymentAttemptNotPendingError : OrderInvalidTransitionError);

    expect(order.snapshot()).toEqual(before);
    expect(order.pullHistory()).toEqual([]);
    expect(order.pullEvents()).toEqual([]);
  });
});
