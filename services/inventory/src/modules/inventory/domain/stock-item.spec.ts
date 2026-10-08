import { describe, expect, it } from 'vitest';

import { LATER, NOW, PRODUCT_A, stockItem, WORKSPACE_ID } from './__test__/builders';
import {
  InsufficientStockError,
  InvalidQuantityError,
  StockBelowReservedError,
  StockNotHeldError,
} from './errors';
import { StockItem } from './stock-item';

const levels = (item: StockItem) => ({
  onHand: item.onHand,
  reserved: item.reserved,
  available: item.available,
});

describe('StockItem.open', () => {
  it('starts with nothing on hand and nothing held', () => {
    const item = StockItem.open({ workspaceId: WORKSPACE_ID, productId: PRODUCT_A, now: NOW });

    expect(item.snapshot()).toEqual({
      workspaceId: WORKSPACE_ID,
      productId: PRODUCT_A,
      onHand: 0,
      reserved: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
});

describe('reserve', () => {
  it('holds units out of what is free', () => {
    const item = stockItem({ onHand: 10, reserved: 3 });

    item.reserve(4, LATER);

    expect(levels(item)).toEqual({ onHand: 10, reserved: 7, available: 3 });
    expect(item.snapshot().updatedAt).toBe(LATER);
  });

  it('holds the last unit', () => {
    const item = stockItem({ onHand: 1 });

    item.reserve(1, LATER);

    expect(levels(item)).toEqual({ onHand: 1, reserved: 1, available: 0 });
  });

  it('refuses more than is free, and changes nothing', () => {
    const item = stockItem({ onHand: 10, reserved: 8 });

    expect(() => {
      item.reserve(3, LATER);
    }).toThrow(InsufficientStockError);
    expect(levels(item)).toEqual({ onHand: 10, reserved: 8, available: 2 });
    expect(item.snapshot().updatedAt).toBe(NOW);
  });

  it('says what was asked and what was free', () => {
    const item = stockItem({ onHand: 10, reserved: 8 });

    expect(() => {
      item.reserve(3, LATER);
    }).toThrow(
      expect.objectContaining({
        code: 'INSUFFICIENT_STOCK',
        details: { productId: PRODUCT_A, requested: 3, available: 2 },
      }),
    );
  });
});

describe('release', () => {
  it('gives held units back', () => {
    const item = stockItem({ onHand: 10, reserved: 7 });

    item.release(4, LATER);

    expect(levels(item)).toEqual({ onHand: 10, reserved: 3, available: 7 });
    expect(item.snapshot().updatedAt).toBe(LATER);
  });

  it('refuses more than is held', () => {
    const item = stockItem({ onHand: 10, reserved: 2 });

    expect(() => {
      item.release(3, LATER);
    }).toThrow(StockNotHeldError);
    expect(levels(item)).toEqual({ onHand: 10, reserved: 2, available: 8 });
  });
});

describe('adjust', () => {
  it('adds units that arrived', () => {
    const item = stockItem({ onHand: 10, reserved: 4 });

    item.adjust(50, LATER);

    expect(levels(item)).toEqual({ onHand: 60, reserved: 4, available: 56 });
    expect(item.snapshot().updatedAt).toBe(LATER);
  });

  it('takes away units that left, down to what is held', () => {
    const item = stockItem({ onHand: 10, reserved: 4 });

    item.adjust(-6, LATER);

    expect(levels(item)).toEqual({ onHand: 4, reserved: 4, available: 0 });
  });

  it('refuses to take away what a reservation holds', () => {
    const item = stockItem({ onHand: 10, reserved: 4 });

    expect(() => {
      item.adjust(-7, LATER);
    }).toThrow(StockBelowReservedError);
    expect(levels(item)).toEqual({ onHand: 10, reserved: 4, available: 6 });
  });

  it('refuses to go below zero', () => {
    const item = stockItem({ onHand: 2 });

    expect(() => {
      item.adjust(-3, LATER);
    }).toThrow(StockBelowReservedError);
  });
});

describe('a number of units', () => {
  it.each([0, -1, 1.5, Number.NaN])('%s is refused by every method', (quantity) => {
    const item = stockItem({ onHand: 10, reserved: 5 });

    expect(() => {
      item.reserve(quantity, LATER);
    }).toThrow(InvalidQuantityError);
    expect(() => {
      item.release(quantity, LATER);
    }).toThrow(InvalidQuantityError);
    expect(levels(item)).toEqual({ onHand: 10, reserved: 5, available: 5 });
  });

  it.each([0, 1.5, Number.NaN])('a delta of %s is refused', (delta) => {
    expect(() => {
      stockItem().adjust(delta, LATER);
    }).toThrow(InvalidQuantityError);
  });
});
