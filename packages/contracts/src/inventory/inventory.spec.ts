import { describe, expect, it } from 'vitest';

import { AdjustStockV1 } from './adjust-stock.v1';
import { ReleaseStockV1 } from './release-stock.v1';
import { ReserveStockV1 } from './reserve-stock.v1';
import { StockAdjustedV1 } from './stock-adjusted.v1';
import { StockReleasedV1 } from './stock-released.v1';
import { StockReservationFailedV1 } from './stock-reservation-failed.v1';
import { StockReservedV1 } from './stock-reserved.v1';

import type { MessageMeta } from '../envelope';

const META: MessageMeta = {
  messageId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e01',
  occurredAt: new Date('2026-10-09T10:15:30.123Z'),
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
};
const ORDER_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04';
const PRODUCT_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e05';
const ATTEMPT = { orderId: ORDER_ID, attempt: 1 };

const reserve = ReserveStockV1.create(META, {
  ...ATTEMPT,
  lines: [{ productId: PRODUCT_ID, quantity: 2 }],
});
const release = ReleaseStockV1.create(META, ATTEMPT);
const adjust = AdjustStockV1.create(META, { productId: PRODUCT_ID, delta: 50 });
const reserved = StockReservedV1.create(META, ATTEMPT);
const failed = StockReservationFailedV1.create(META, {
  ...ATTEMPT,
  reason: 'insufficient_stock',
  shortages: [{ productId: PRODUCT_ID, requested: 2, available: 0 }],
});
const released = StockReleasedV1.create(META, ATTEMPT);
const adjusted = StockAdjustedV1.create(META, { productId: PRODUCT_ID, onHand: 50, reserved: 0 });

const withPayload = (message: { payload: object }, change: Record<string, unknown>): unknown => ({
  ...message,
  payload: { ...message.payload, ...change },
});

describe.each([
  { contract: ReserveStockV1, name: 'inventory.reserve-stock', message: reserve },
  { contract: ReleaseStockV1, name: 'inventory.release-stock', message: release },
  { contract: AdjustStockV1, name: 'inventory.adjust-stock', message: adjust },
  { contract: StockReservedV1, name: 'inventory.stock-reserved', message: reserved },
  {
    contract: StockReservationFailedV1,
    name: 'inventory.stock-reservation-failed',
    message: failed,
  },
  { contract: StockReleasedV1, name: 'inventory.stock-released', message: released },
  { contract: StockAdjustedV1, name: 'inventory.stock-adjusted', message: adjusted },
])('$name v1', ({ contract, name, message }) => {
  it('keeps its name and version', () => {
    expect([contract.name, contract.version]).toEqual([name, 1]);
    expect([message.name, message.version]).toEqual([name, 1]);
  });

  it('survives JSON', () => {
    expect(contract.schema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it('reads a message that gained a field', () => {
    expect(contract.schema.parse(withPayload(message, { addedLater: true }))).toEqual(message);
  });

  it.each(Object.keys(message.payload))('requires payload.%s', (field) => {
    const broken = withPayload(message, { [field]: undefined });

    expect(contract.schema.safeParse(broken).success).toBe(false);
  });
});

describe.each([
  { contract: ReserveStockV1, name: ReserveStockV1.name, message: reserve },
  { contract: ReleaseStockV1, name: ReleaseStockV1.name, message: release },
  { contract: StockReservedV1, name: StockReservedV1.name, message: reserved },
  { contract: StockReservationFailedV1, name: StockReservationFailedV1.name, message: failed },
  { contract: StockReleasedV1, name: StockReleasedV1.name, message: released },
])('$name v1: the attempt of an order', ({ contract, message }) => {
  it.each([
    ['an order id that is not a uuid', { orderId: 'order-1' }],
    ['attempt 0', { attempt: 0 }],
    ['a fractional attempt', { attempt: 1.5 }],
    ['an attempt sent as a string', { attempt: '1' }],
  ])('rejects %s', (_case, change) => {
    expect(contract.schema.safeParse(withPayload(message, change)).success).toBe(false);
  });
});

describe('inventory.reserve-stock v1: lines', () => {
  it.each([
    ['no lines', []],
    ['quantity 0', [{ productId: PRODUCT_ID, quantity: 0 }]],
    ['a negative quantity', [{ productId: PRODUCT_ID, quantity: -1 }]],
    ['a fractional quantity', [{ productId: PRODUCT_ID, quantity: 1.5 }]],
    ['a product id that is not a uuid', [{ productId: 'sku-1', quantity: 1 }]],
    ['a line with no quantity', [{ productId: PRODUCT_ID }]],
  ])('rejects %s', (_case, lines) => {
    expect(ReserveStockV1.schema.safeParse(withPayload(reserve, { lines })).success).toBe(false);
  });

  it('accepts the same product on two lines: the receiver adds them up', () => {
    const line = { productId: PRODUCT_ID, quantity: 1 };
    const message = withPayload(reserve, { lines: [line, line] });

    expect(ReserveStockV1.schema.safeParse(message).success).toBe(true);
  });
});

describe('inventory.adjust-stock v1', () => {
  it('accepts a negative delta: stock that left', () => {
    expect(AdjustStockV1.schema.safeParse(withPayload(adjust, { delta: -3 })).success).toBe(true);
  });

  it.each([
    ['delta 0', { delta: 0 }],
    ['a fractional delta', { delta: 1.5 }],
    ['a delta sent as a string', { delta: '5' }],
  ])('rejects %s', (_case, change) => {
    expect(AdjustStockV1.schema.safeParse(withPayload(adjust, change)).success).toBe(false);
  });
});

describe('inventory.stock-reservation-failed v1: shortages', () => {
  it.each([
    ['no shortage', []],
    ['a negative availability', [{ productId: PRODUCT_ID, requested: 2, available: -1 }]],
    ['nothing requested', [{ productId: PRODUCT_ID, requested: 0, available: 0 }]],
  ])('rejects %s', (_case, shortages) => {
    const message = withPayload(failed, { shortages });

    expect(StockReservationFailedV1.schema.safeParse(message).success).toBe(false);
  });
});

describe('inventory.stock-adjusted v1', () => {
  it.each([
    ['a negative stock on hand', { onHand: -1 }],
    ['a negative reserved', { reserved: -1 }],
  ])('rejects %s', (_case, change) => {
    expect(StockAdjustedV1.schema.safeParse(withPayload(adjusted, change)).success).toBe(false);
  });
});
