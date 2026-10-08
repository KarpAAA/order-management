import { Money } from '@shared/domain/money';

import { NO_DISCOUNT } from '../discount';
import { Order } from '../order';
import { OrderLine } from '../order-line';
import { OrderSaga } from '../order-saga';
import { OrderSagaStep } from '../order-saga-step';
import { OrderStatus } from '../order-status';

import type { OrderLineInput, OrderProps } from '../order';
import type { OrderLineProps } from '../order-line';
import type { OrderSagaProps } from '../order-saga';

export const CURRENCY = 'EUR';
export const TAX_RATE_BPS = 2000;
export const NOW = new Date('2026-01-15T10:00:00.000Z');
export const LATER = new Date('2026-01-15T11:00:00.000Z');

export const WORKSPACE = '01950000-0000-7000-8000-00000000a001';
export const ORDER = '01950000-0000-7000-8000-00000000b001';
export const USER = '01950000-0000-7000-8000-00000000c001';
export const PRODUCT_1 = '01950000-0000-7000-8000-00000000d001';
export const PRODUCT_2 = '01950000-0000-7000-8000-00000000d002';
export const SYSTEM_ACTOR = 'system:consumer:orders';

/** Who and when for a state change; defaults to the user acting LATER than the order was built. */
export function change(overrides: Partial<{ now: Date; changedBy: string }> = {}): {
  now: Date;
  changedBy: string;
} {
  return { now: LATER, changedBy: USER, ...overrides };
}

/** A valid item as the caller sends it, with the catalog data to snapshot. */
export function lineInput(overrides: Partial<OrderLineInput> = {}): OrderLineInput {
  return {
    productId: PRODUCT_1,
    sku: 'SKU-1',
    name: 'Product 1',
    unitPriceMinor: 1250n,
    isActive: true,
    quantity: 1,
    ...overrides,
  };
}

/** `count` valid items with distinct products. */
export function lineInputs(count: number): OrderLineInput[] {
  return Array.from({ length: count }, (_, i) =>
    lineInput({ productId: `product-${i}`, sku: `SKU-${i}`, name: `Product ${i}` }),
  );
}

export function orderLine(overrides: Partial<OrderLineProps> = {}): OrderLine {
  return OrderLine.restore({
    id: '01950000-0000-7000-8000-00000000e001',
    position: 0,
    productId: PRODUCT_1,
    sku: 'SKU-1',
    name: 'Product 1',
    unitPrice: Money.of(1250n, CURRENCY),
    quantity: 1,
    ...overrides,
  });
}

/** What each status implies about the rest of the order, so a restored order is consistent. */
const STATUS_PROPS: Readonly<Record<OrderStatus, Partial<OrderProps>>> = {
  [OrderStatus.Draft]: {},
  [OrderStatus.PendingPayment]: { paymentAttempt: 1, placedAt: NOW },
  [OrderStatus.PaymentFailed]: { paymentAttempt: 1, placedAt: NOW, failureReason: 'card_declined' },
  [OrderStatus.Paid]: { paymentAttempt: 1, placedAt: NOW, paidAt: NOW, pspChargeId: 'ch_1' },
  [OrderStatus.Fulfilled]: {
    paymentAttempt: 1,
    placedAt: NOW,
    paidAt: NOW,
    pspChargeId: 'ch_1',
    fulfilledAt: NOW,
  },
  [OrderStatus.Cancelled]: { cancelledAt: NOW },
};

/** Valid props of an order in `status` with one item; tests override only what they test. */
export function orderProps(status: OrderStatus, overrides: Partial<OrderProps> = {}): OrderProps {
  return {
    workspaceId: WORKSPACE,
    id: ORDER,
    status,
    currency: CURRENCY,
    discount: NO_DISCOUNT,
    taxRateBps: TAX_RATE_BPS,
    lines: [orderLine()],
    paymentAttempt: 0,
    pspChargeId: null,
    failureReason: null,
    version: 3,
    createdBy: USER,
    createdAt: NOW,
    updatedAt: NOW,
    placedAt: null,
    paidAt: null,
    fulfilledAt: null,
    cancelledAt: null,
    ...STATUS_PROPS[status],
    ...overrides,
  };
}

export function orderIn(status: OrderStatus, overrides: Partial<OrderProps> = {}): Order {
  return Order.restore(orderProps(status, overrides));
}

/** When the timeout of the step a restored saga waits in goes off. */
export const DEADLINE = new Date('2026-01-15T10:05:00.000Z');

const ENDED: readonly OrderSagaStep[] = [OrderSagaStep.Completed, OrderSagaStep.Aborted];

/** The saga of attempt 1 of ORDER in `step`, at version 2; tests override only what they test. */
export function sagaIn(step: OrderSagaStep, overrides: Partial<OrderSagaProps> = {}): OrderSaga {
  return OrderSaga.restore({
    workspaceId: WORKSPACE,
    orderId: ORDER,
    attempt: 1,
    step,
    deadlineAt: ENDED.includes(step) ? null : DEADLINE,
    cancelRequestedAt: null,
    version: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}
