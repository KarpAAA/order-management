import { describe, expect, it } from 'vitest';

import { ATTEMPT, LATER, NOW, PRODUCT_A, PRODUCT_B, stockItem, stockOf } from './__test__/builders';
import { allocate, mergeLines } from './allocation';
import { InvalidQuantityError } from './errors';
import { ReservationStatus } from './reservation-status';

describe('mergeLines', () => {
  it('adds up a product asked on two lines', () => {
    const merged = mergeLines([
      { productId: PRODUCT_A, quantity: 2 },
      { productId: PRODUCT_B, quantity: 1 },
      { productId: PRODUCT_A, quantity: 3 },
    ]);

    expect(merged).toEqual([
      { productId: PRODUCT_A, quantity: 5 },
      { productId: PRODUCT_B, quantity: 1 },
    ]);
  });

  it.each([0, -1, 1.5])('refuses a quantity of %s', (quantity) => {
    expect(() => mergeLines([{ productId: PRODUCT_A, quantity }])).toThrow(InvalidQuantityError);
  });
});

describe('allocate', () => {
  it('holds every line and returns a RESERVED reservation', () => {
    const a = stockItem({ productId: PRODUCT_A, onHand: 10 });
    const b = stockItem({ productId: PRODUCT_B, onHand: 3, reserved: 1 });

    const reservation = allocate(
      {
        ...ATTEMPT,
        lines: [
          { productId: PRODUCT_A, quantity: 4 },
          { productId: PRODUCT_B, quantity: 2 },
        ],
      },
      stockOf(a, b),
      LATER,
    );

    expect(reservation.snapshot()).toMatchObject({
      ...ATTEMPT,
      status: ReservationStatus.Reserved,
      lines: [
        { productId: PRODUCT_A, quantity: 4, available: null },
        { productId: PRODUCT_B, quantity: 2, available: null },
      ],
      createdAt: LATER,
    });
    expect([a.reserved, b.reserved]).toEqual([4, 3]);
  });

  it('holds nothing when one line falls short: every line or none', () => {
    const a = stockItem({ productId: PRODUCT_A, onHand: 10 });
    const b = stockItem({ productId: PRODUCT_B, onHand: 3, reserved: 2 });

    const reservation = allocate(
      {
        ...ATTEMPT,
        lines: [
          { productId: PRODUCT_A, quantity: 4 },
          { productId: PRODUCT_B, quantity: 2 },
        ],
      },
      stockOf(a, b),
      LATER,
    );

    expect(reservation.status).toBe(ReservationStatus.Rejected);
    expect(reservation.shortages).toEqual([{ productId: PRODUCT_B, requested: 2, available: 1 }]);
    expect([a.reserved, b.reserved]).toEqual([0, 2]);
    expect(a.snapshot().updatedAt).toBe(NOW);
  });

  it('names every product that fell short, not only the first', () => {
    const reservation = allocate(
      {
        ...ATTEMPT,
        lines: [
          { productId: PRODUCT_A, quantity: 11 },
          { productId: PRODUCT_B, quantity: 1 },
        ],
      },
      stockOf(stockItem({ productId: PRODUCT_A, onHand: 10 })),
      LATER,
    );

    expect(reservation.shortages).toEqual([
      { productId: PRODUCT_A, requested: 11, available: 10 },
      { productId: PRODUCT_B, requested: 1, available: 0 },
    ]);
  });

  it('treats a product with no stock item as having nothing free', () => {
    const reservation = allocate(
      { ...ATTEMPT, lines: [{ productId: PRODUCT_A, quantity: 1 }] },
      stockOf(),
      LATER,
    );

    expect(reservation.shortages).toEqual([{ productId: PRODUCT_A, requested: 1, available: 0 }]);
  });

  it('checks a product asked on two lines against their sum', () => {
    const a = stockItem({ productId: PRODUCT_A, onHand: 3 });
    const line = { productId: PRODUCT_A, quantity: 2 };

    const reservation = allocate({ ...ATTEMPT, lines: [line, line] }, stockOf(a), LATER);

    expect(reservation.shortages).toEqual([{ productId: PRODUCT_A, requested: 4, available: 3 }]);
    expect(a.reserved).toBe(0);
  });

  it('holds the last unit, and the next request for it is rejected', () => {
    const a = stockItem({ productId: PRODUCT_A, onHand: 1 });
    const request = { ...ATTEMPT, lines: [{ productId: PRODUCT_A, quantity: 1 }] };

    const first = allocate(request, stockOf(a), NOW);
    const second = allocate({ ...request, attempt: 2 }, stockOf(a), LATER);

    expect([first.status, second.status]).toEqual([
      ReservationStatus.Reserved,
      ReservationStatus.Rejected,
    ]);
    expect(a.reserved).toBe(1);
  });
});
