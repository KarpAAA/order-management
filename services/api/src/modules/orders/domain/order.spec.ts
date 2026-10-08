import { describe, expect, it } from 'vitest';

import { StaleVersionError } from '@shared/errors/domain-error';

import {
  change,
  CURRENCY,
  LATER,
  lineInput,
  lineInputs,
  NOW,
  orderIn,
  PRODUCT_1,
  PRODUCT_2,
  SYSTEM_ACTOR,
  TAX_RATE_BPS,
  USER,
  WORKSPACE,
} from './__test__/builders';
import { DiscountType, NO_DISCOUNT } from './discount';
import {
  InvalidOrderError,
  OrderHasNoItemsError,
  OrderNotEditableError,
  PaymentAttemptNotPendingError,
  ProductNotActiveError,
} from './errors';
import { OrderCancelled } from './events/order-cancelled.event';
import { OrderFulfilled } from './events/order-fulfilled.event';
import { OrderPaid } from './events/order-paid.event';
import { OrderPlaced } from './events/order-placed.event';
import { Order } from './order';
import { OrderEventType, OrderStatus } from './order-status';

import type { Discount } from './discount';
import type { OrderLineInput } from './order';

function draft(lines: readonly OrderLineInput[] = [lineInput()], discount?: Discount): Order {
  return Order.draft({
    workspaceId: WORKSPACE,
    currency: CURRENCY,
    taxRateBps: TAX_RATE_BPS,
    lines,
    ...(discount === undefined ? {} : { discount }),
    createdBy: USER,
    now: NOW,
  });
}

describe('Order.draft', () => {
  it('ORD-001 creates a DRAFT with paymentAttempt 0 and version 0', () => {
    const order = draft();
    expect(order.status).toBe(OrderStatus.Draft);
    expect(order.paymentAttempt).toBe(0);
    expect(order.version).toBe(0);
    expect(order.workspaceId).toBe(WORKSPACE);
  });

  it('ORD-019 records ORDER_CREATED from null to DRAFT, by the creator', () => {
    const order = draft();
    expect(order.pullHistory()).toEqual([
      expect.objectContaining({
        type: OrderEventType.OrderCreated,
        fromStatus: null,
        toStatus: OrderStatus.Draft,
        changedBy: USER,
        payload: {},
        at: NOW,
      }),
    ]);
    expect(order.pullEvents()).toEqual([]);
  });

  it('ORD-002 accepts a draft with no items', () => {
    expect(draft([]).lines).toHaveLength(0);
  });

  it('ORD-002 accepts 50 items', () => {
    expect(draft(lineInputs(50)).lines).toHaveLength(50);
  });

  it('ORD-002 rejects 51 items', () => {
    expect(() => draft(lineInputs(51))).toThrow(
      expect.objectContaining({ code: 'INVALID_ORDER', details: { count: 51 } }),
    );
  });

  it('ORD-004 rejects the same product twice, naming it', () => {
    const lines = [lineInput(), lineInput({ sku: 'OTHER' })];
    expect(() => draft(lines)).toThrow(
      expect.objectContaining({ code: 'INVALID_ORDER', details: { productId: PRODUCT_1 } }),
    );
  });

  it('ORD-006 rejects an archived product', () => {
    expect(() => draft([lineInput({ isActive: false })])).toThrow(ProductNotActiveError);
  });

  it('CALC-012 CALC-013 takes the currency and tax rate it was created with', () => {
    const snapshot = draft().snapshot();
    expect(snapshot.currency).toBe(CURRENCY);
    expect(snapshot.taxRateBps).toBe(TAX_RATE_BPS);
  });

  it('CALC-014 snapshots sku, name and unit price of every item, in the given order', () => {
    const order = draft([
      lineInput({ productId: PRODUCT_2, sku: 'SKU-2', name: 'Second', unitPriceMinor: 700n }),
      lineInput({ productId: PRODUCT_1, sku: 'SKU-1', name: 'First', unitPriceMinor: 1250n }),
    ]);
    expect(
      order.lines.map((line) => {
        const s = line.snapshot();
        return [s.position, s.productId, s.sku, s.name, s.unitPrice.amountMinor];
      }),
    ).toEqual([
      [0, PRODUCT_2, 'SKU-2', 'Second', 700n],
      [1, PRODUCT_1, 'SKU-1', 'First', 1250n],
    ]);
  });

  it('has no discount unless one is given', () => {
    expect(draft().snapshot().discount).toEqual(NO_DISCOUNT);
  });

  it('CALC-015 computes its totals and the amount due from its items', () => {
    const order = draft([lineInput({ unitPriceMinor: 1250n, quantity: 3 })], {
      type: DiscountType.Percent,
      valueBps: 1000,
    });
    expect(order.totals.total.amountMinor).toBe(4050n);
    expect(order.amountDue.equals(order.totals.total)).toBe(true);
  });
});

describe('Order.replaceContents', () => {
  const discount: Discount = { type: DiscountType.Fixed, valueMinor: 100n };

  it('ORD-008 replaces items and discount of a DRAFT', () => {
    const order = orderIn(OrderStatus.Draft);
    order.replaceContents({ lines: [lineInput({ productId: PRODUCT_2 })], discount, now: LATER });
    expect(order.lines.map((line) => line.productId)).toEqual([PRODUCT_2]);
    expect(order.snapshot().discount).toEqual(discount);
    expect(order.snapshot().updatedAt).toBe(LATER);
  });

  it('ORD-019 appends no history: it is not a status change', () => {
    const order = orderIn(OrderStatus.Draft);
    order.replaceContents({ lines: [lineInput()], discount, now: LATER });
    expect(order.pullHistory()).toEqual([]);
  });

  it('ORD-002 rejects 51 items', () => {
    const order = orderIn(OrderStatus.Draft);
    expect(() => {
      order.replaceContents({ lines: lineInputs(51), discount, now: LATER });
    }).toThrow(InvalidOrderError);
  });

  it.each([
    OrderStatus.PendingPayment,
    OrderStatus.PaymentFailed,
    OrderStatus.Paid,
    OrderStatus.Fulfilled,
    OrderStatus.Cancelled,
  ])('ORD-008 refuses to edit a %s order and changes nothing', (status) => {
    const order = orderIn(status);
    const before = order.snapshot();
    expect(() => {
      order.replaceContents({ lines: [lineInput({ productId: PRODUCT_2 })], discount, now: LATER });
    }).toThrow(OrderNotEditableError);
    expect(order.snapshot()).toEqual(before);
  });
});

describe('Order.place', () => {
  it('ORD-011 from DRAFT starts payment attempt 1', () => {
    const order = orderIn(OrderStatus.Draft);
    order.place(change());
    expect(order.status).toBe(OrderStatus.PendingPayment);
    expect(order.paymentAttempt).toBe(1);
    expect(order.snapshot().placedAt).toBe(LATER);
  });

  it('ORD-021 records ORDER_PLACED with the payment attempt', () => {
    const order = orderIn(OrderStatus.Draft);
    order.place(change());
    expect(order.pullHistory()).toEqual([
      expect.objectContaining({
        type: OrderEventType.OrderPlaced,
        fromStatus: OrderStatus.Draft,
        toStatus: OrderStatus.PendingPayment,
        changedBy: USER,
        payload: { paymentAttempt: 1 },
        at: LATER,
      }),
    ]);
  });

  it('PAY-001 publishes OrderPlaced for the new attempt with the amount due, to request the charge', () => {
    const order = orderIn(OrderStatus.Draft);
    order.place(change());
    const events = order.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OrderPlaced);
    expect(events[0]).toMatchObject({
      name: 'order.placed',
      delivery: 'reliable',
      workspaceId: WORKSPACE,
      orderId: order.id,
      paymentAttempt: 1,
      amountDue: order.totals.total,
      occurredAt: LATER,
    });
  });

  it('ORD-011 PAY-011 from PAYMENT_FAILED starts the next attempt and clears the failure', () => {
    const order = orderIn(OrderStatus.PaymentFailed);
    order.place(change());
    expect(order.status).toBe(OrderStatus.PendingPayment);
    expect(order.paymentAttempt).toBe(2);
    expect(order.snapshot().failureReason).toBeNull();
  });

  it('ORD-012 refuses an order with no items and changes nothing', () => {
    const order = orderIn(OrderStatus.Draft, { lines: [] });
    const before = order.snapshot();
    expect(() => {
      order.place(change());
    }).toThrow(OrderHasNoItemsError);
    expect(order.snapshot()).toEqual(before);
    expect(order.pullEvents()).toEqual([]);
  });
});

describe('Order.cancel', () => {
  it.each([OrderStatus.Draft, OrderStatus.PaymentFailed])(
    'ORD-014 cancels a %s order and records ORDER_CANCELLED',
    (status) => {
      const order = orderIn(status);
      order.cancel(change());
      expect(order.status).toBe(OrderStatus.Cancelled);
      expect(order.snapshot().cancelledAt).toBe(LATER);
      expect(order.pullHistory()).toEqual([
        expect.objectContaining({
          type: OrderEventType.OrderCancelled,
          fromStatus: status,
          toStatus: OrderStatus.Cancelled,
          payload: {},
        }),
      ]);
    },
  );

  it('OBX-007 records OrderCancelled, reliable', () => {
    const order = orderIn(OrderStatus.Draft);
    order.cancel(change());
    expect(order.pullEvents()).toEqual([new OrderCancelled(WORKSPACE, order.id, LATER)]);
    expect(new OrderCancelled(WORKSPACE, order.id, LATER).delivery).toBe('reliable');
  });
});

describe('Order.fulfill', () => {
  it('ORD-017 fulfills a PAID order and records ORDER_FULFILLED', () => {
    const order = orderIn(OrderStatus.Paid);
    order.fulfill(change());
    expect(order.status).toBe(OrderStatus.Fulfilled);
    expect(order.snapshot().fulfilledAt).toBe(LATER);
    expect(order.pullHistory()).toEqual([
      expect.objectContaining({
        type: OrderEventType.OrderFulfilled,
        fromStatus: OrderStatus.Paid,
        toStatus: OrderStatus.Fulfilled,
        payload: {},
      }),
    ]);
  });

  it('OBX-007 records OrderFulfilled, reliable', () => {
    const order = orderIn(OrderStatus.Paid);
    order.fulfill(change());
    expect(order.pullEvents()).toEqual([new OrderFulfilled(WORKSPACE, order.id, LATER)]);
    expect(new OrderFulfilled(WORKSPACE, order.id, LATER).delivery).toBe('reliable');
  });
});

describe('Order.markPaid', () => {
  it('PAY-004 ORD-021 marks the awaited attempt PAID with the PSP charge', () => {
    const order = orderIn(OrderStatus.PendingPayment);
    order.markPaid({ ...change({ changedBy: SYSTEM_ACTOR }), attempt: 1, pspChargeId: 'ch_42' });
    const snapshot = order.snapshot();
    expect(order.status).toBe(OrderStatus.Paid);
    expect(snapshot.pspChargeId).toBe('ch_42');
    expect(snapshot.paidAt).toBe(LATER);
    expect(order.pullHistory()).toEqual([
      expect.objectContaining({
        type: OrderEventType.PaymentSucceeded,
        fromStatus: OrderStatus.PendingPayment,
        toStatus: OrderStatus.Paid,
        changedBy: SYSTEM_ACTOR,
        payload: { paymentAttempt: 1, pspChargeId: 'ch_42' },
      }),
    ]);
  });

  it('OBX-007 records OrderPaid with the attempt and the charge, reliable', () => {
    const order = orderIn(OrderStatus.PendingPayment);
    order.markPaid({ ...change({ changedBy: SYSTEM_ACTOR }), attempt: 1, pspChargeId: 'ch_42' });
    expect(order.pullEvents()).toEqual([new OrderPaid(WORKSPACE, order.id, 1, 'ch_42', LATER)]);
    expect(new OrderPaid(WORKSPACE, order.id, 1, 'ch_42', LATER).delivery).toBe('reliable');
  });
});

describe('Order.markPaymentFailed', () => {
  it('ORD-021 marks the awaited attempt PAYMENT_FAILED with the reason', () => {
    const order = orderIn(OrderStatus.PendingPayment);
    order.markPaymentFailed({
      ...change({ changedBy: SYSTEM_ACTOR }),
      attempt: 1,
      reason: 'card_declined',
    });
    expect(order.status).toBe(OrderStatus.PaymentFailed);
    expect(order.snapshot().failureReason).toBe('card_declined');
    expect(order.pullHistory()).toEqual([
      expect.objectContaining({
        type: OrderEventType.PaymentFailed,
        fromStatus: OrderStatus.PendingPayment,
        toStatus: OrderStatus.PaymentFailed,
        changedBy: SYSTEM_ACTOR,
        payload: { paymentAttempt: 1, reason: 'card_declined' },
      }),
    ]);
  });
});

describe('payment outcome of another attempt', () => {
  const outcomes = {
    markPaid: (order: Order, attempt: number) => {
      order.markPaid({ ...change(), attempt, pspChargeId: 'ch_1' });
    },
    markPaymentFailed: (order: Order, attempt: number) => {
      order.markPaymentFailed({ ...change(), attempt, reason: 'card_declined' });
    },
  };

  it.each(Object.entries(outcomes))(
    'PAY-009 %s of a stale attempt is refused and changes nothing',
    (_name, apply) => {
      const order = orderIn(OrderStatus.PendingPayment, { paymentAttempt: 2 });
      const before = order.snapshot();
      expect(() => {
        apply(order, 1);
      }).toThrow(PaymentAttemptNotPendingError);
      expect(order.snapshot()).toEqual(before);
      expect(order.pullHistory()).toEqual([]);
    },
  );

  it('PAY-009 the awaited attempt passes the guard', () => {
    const order = orderIn(OrderStatus.PendingPayment, { paymentAttempt: 2 });
    expect(() => {
      order.assertAwaitingPayment(2);
    }).not.toThrow();
  });
});

describe('Order.assertVersion', () => {
  it('ORD-009 accepts the current version', () => {
    const order = orderIn(OrderStatus.Draft, { version: 3 });
    expect(() => {
      order.assertVersion(3);
    }).not.toThrow();
  });

  it.each([2, 4])('ORD-009 rejects version %s when the order is at 3', (expected) => {
    const order = orderIn(OrderStatus.Draft, { version: 3 });
    expect(() => {
      order.assertVersion(expected);
    }).toThrow(StaleVersionError);
  });
});
