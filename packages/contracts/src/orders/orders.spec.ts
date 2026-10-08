import { describe, expect, it } from 'vitest';

import { OrderCancelledV1 } from './order-cancelled.v1';
import { OrderFulfilledV1 } from './order-fulfilled.v1';
import { OrderPaidV1 } from './order-paid.v1';
import { OrderPlacedV1 } from './order-placed.v1';

import type { MessageMeta } from '../envelope';

const META: MessageMeta = {
  messageId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e01',
  occurredAt: new Date('2026-10-08T10:15:30.123Z'),
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
};
const ORDER_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04';

const placed = OrderPlacedV1.create(META, {
  orderId: ORDER_ID,
  paymentAttempt: 1,
  amount: { amountMinor: 12_990, currency: 'EUR' },
});
const paid = OrderPaidV1.create(META, { orderId: ORDER_ID, paymentAttempt: 1, chargeId: 'ch_1' });
const cancelled = OrderCancelledV1.create(META, { orderId: ORDER_ID });
const fulfilled = OrderFulfilledV1.create(META, { orderId: ORDER_ID });

const CASES = [
  { contract: OrderPlacedV1, name: 'orders.order-placed', message: placed },
  { contract: OrderPaidV1, name: 'orders.order-paid', message: paid },
  { contract: OrderCancelledV1, name: 'orders.order-cancelled', message: cancelled },
  { contract: OrderFulfilledV1, name: 'orders.order-fulfilled', message: fulfilled },
];

describe.each(CASES)('$name v1', ({ contract, name, message }) => {
  const withPayload = (change: Record<string, unknown>): unknown => ({
    ...message,
    payload: { ...message.payload, ...change },
  });

  it('keeps its name and version', () => {
    expect([contract.name, contract.version]).toEqual([name, 1]);
    expect([message.name, message.version]).toEqual([name, 1]);
  });

  it('survives JSON', () => {
    expect(contract.schema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it('reads a message that gained a field', () => {
    expect(contract.schema.parse(withPayload({ addedLater: true }))).toEqual(message);
  });

  it.each(Object.keys(message.payload))('requires payload.%s', (field) => {
    expect(contract.schema.safeParse(withPayload({ [field]: undefined })).success).toBe(false);
  });

  it('rejects an order id that is not a uuid', () => {
    expect(contract.schema.safeParse(withPayload({ orderId: 'order-1' })).success).toBe(false);
  });
});

describe.each([
  { name: 'orders.order-placed', contract: OrderPlacedV1, message: placed },
  { name: 'orders.order-paid', contract: OrderPaidV1, message: paid },
])('$name v1: the payment attempt', ({ contract, message }) => {
  it.each([
    ['attempt 0', 0],
    ['a fractional attempt', 1.5],
    ['an attempt sent as a string', '1'],
  ])('rejects %s', (_case, paymentAttempt) => {
    const changed = { ...message, payload: { ...message.payload, paymentAttempt } };

    expect(contract.schema.safeParse(changed).success).toBe(false);
  });
});

describe('orders.order-placed v1: amount', () => {
  it.each([
    ['a negative amount', { amountMinor: -1, currency: 'EUR' }],
    ['an amount past 2^53', { amountMinor: 2 ** 53, currency: 'EUR' }],
    ['a lower-case currency', { amountMinor: 12_990, currency: 'eur' }],
  ])('rejects %s', (_case, amount) => {
    const changed = { ...placed, payload: { ...placed.payload, amount } };

    expect(OrderPlacedV1.schema.safeParse(changed).success).toBe(false);
  });
});

describe('orders.order-paid v1: the charge id', () => {
  it('is never empty', () => {
    const changed = { ...paid, payload: { ...paid.payload, chargeId: '' } };

    expect(OrderPaidV1.schema.safeParse(changed).success).toBe(false);
  });
});
