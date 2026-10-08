import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DomainError } from '@shared/errors/domain-error';

import { ATTEMPT, NOW, stockItem, stockOf } from './__test__/builders';
import { allocate } from './allocation';

import type { Reservation } from './reservation';
import type { StockItem } from './stock-item';

const PRODUCTS = ['a', 'b', 'c'] as const;

type Step =
  | { kind: 'reserve'; lines: { productId: string; quantity: number }[] }
  | { kind: 'release'; index: number }
  | { kind: 'adjust'; productId: string; delta: number };

const product = fc.constantFrom(...PRODUCTS);
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('reserve' as const),
    lines: fc.array(fc.record({ productId: product, quantity: fc.integer({ min: 1, max: 6 }) }), {
      minLength: 1,
      maxLength: 4,
    }),
  }),
  fc.record({ kind: fc.constant('release' as const), index: fc.nat({ max: 20 }) }),
  fc.record({
    kind: fc.constant('adjust' as const),
    productId: product,
    delta: fc.integer({ min: -8, max: 8 }).filter((delta) => delta !== 0),
  }),
);

/** What the use cases do with the domain, without a database: a refusal changes nothing. */
function run(steps: Step[], stock: Map<string, StockItem>): Reservation[] {
  const reservations: Reservation[] = [];
  for (const [attempt, current] of steps.entries()) {
    try {
      if (current.kind === 'reserve') {
        reservations.push(allocate({ ...ATTEMPT, attempt: attempt + 1, ...current }, stock, NOW));
      } else if (current.kind === 'adjust') {
        stock.get(current.productId)?.adjust(current.delta, NOW);
      } else {
        const reservation = reservations[current.index % Math.max(reservations.length, 1)];
        if (reservation?.holdsStock) {
          for (const line of reservation.lines) {
            stock.get(line.productId)?.release(line.quantity, NOW);
          }
          reservation.release(NOW);
        }
      }
    } catch (err: unknown) {
      if (!(err instanceof DomainError)) throw err;
    }
  }
  return reservations;
}

const freshStock = (onHand: number[]) =>
  stockOf(...PRODUCTS.map((productId, i) => stockItem({ productId, onHand: onHand[i] ?? 0 })));

const levels = fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 3, maxLength: 3 });

describe('any sequence of reserve, release and adjust', () => {
  it('never holds more than there is, and never less than nothing', () => {
    fc.assert(
      fc.property(levels, fc.array(step, { maxLength: 40 }), (onHand, steps) => {
        const stock = freshStock(onHand);

        run(steps, stock);

        for (const item of stock.values()) {
          expect(item.reserved).toBeGreaterThanOrEqual(0);
          expect(item.reserved).toBeLessThanOrEqual(item.onHand);
        }
      }),
    );
  });

  it('holds of each product exactly what its RESERVED reservations hold', () => {
    fc.assert(
      fc.property(levels, fc.array(step, { maxLength: 40 }), (onHand, steps) => {
        const stock = freshStock(onHand);

        const reservations = run(steps, stock);

        for (const item of stock.values()) {
          const held = reservations
            .filter((reservation) => reservation.holdsStock)
            .flatMap((reservation) => reservation.lines)
            .filter((line) => line.productId === item.productId)
            .reduce((sum, line) => sum + line.quantity, 0);
          expect(item.reserved).toBe(held);
        }
      }),
    );
  });

  it('leaves the stock as it was when a reservation is rejected', () => {
    fc.assert(
      fc.property(levels, fc.array(step, { maxLength: 20 }), (onHand, steps) => {
        const stock = freshStock(onHand);
        run(steps, stock);
        const before = [...stock.values()].map((item) => item.snapshot());

        const reservation = allocate(
          { ...ATTEMPT, attempt: 99, lines: [{ productId: 'a', quantity: 1000 }] },
          stock,
          NOW,
        );

        expect(reservation.holdsStock).toBe(false);
        expect([...stock.values()].map((item) => item.snapshot())).toEqual(before);
      }),
    );
  });
});
