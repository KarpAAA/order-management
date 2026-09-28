import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DiscountType, discountOf, MAX_PERCENT_BPS } from './discount';
import { InvalidOrderError } from './errors';

/** Anything a command could carry: valid values, fractions, NaN, negatives, both fields, none. */
const rawInputArb = fc.record({
  type: fc.constantFrom(...Object.values(DiscountType)),
  valueBps: fc.option(
    fc.oneof(
      fc.integer({ min: -20_000, max: 20_000 }),
      fc.double(),
      fc.constantFrom(0, MAX_PERCENT_BPS),
    ),
    { nil: undefined },
  ),
  valueMinor: fc.option(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), { nil: undefined }),
});

describe('discountOf properties', () => {
  it('ORD-007 either returns a valid discount of the requested type or throws InvalidOrderError', () => {
    fc.assert(
      fc.property(rawInputArb, (input) => {
        let discount;
        try {
          discount = discountOf(input);
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidOrderError);
          return;
        }
        expect(discount.type).toBe(input.type);
        switch (discount.type) {
          case DiscountType.None:
            expect(input.valueBps).toBeUndefined();
            expect(input.valueMinor).toBeUndefined();
            break;
          case DiscountType.Percent:
            expect(Number.isInteger(discount.valueBps)).toBe(true);
            expect(discount.valueBps).toBeGreaterThanOrEqual(0);
            expect(discount.valueBps).toBeLessThanOrEqual(MAX_PERCENT_BPS);
            expect(input.valueMinor).toBeUndefined();
            break;
          case DiscountType.Fixed:
            expect(discount.valueMinor).toBeGreaterThanOrEqual(0n);
            expect(input.valueBps).toBeUndefined();
            break;
        }
      }),
    );
  });

  // The counterpart: without it, a discountOf that always throws would pass the test above.
  it('ORD-007 accepts every valid PERCENT and FIXED value unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_PERCENT_BPS }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (valueBps, valueMinor) => {
          expect(discountOf({ type: DiscountType.Percent, valueBps })).toEqual({
            type: DiscountType.Percent,
            valueBps,
          });
          expect(discountOf({ type: DiscountType.Fixed, valueMinor })).toEqual({
            type: DiscountType.Fixed,
            valueMinor,
          });
        },
      ),
    );
  });
});
