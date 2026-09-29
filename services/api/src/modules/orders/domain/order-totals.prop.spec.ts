import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Money } from '@shared/domain/money';

import {
  discountArb,
  fixedMinorArb,
  lineTotalsArb,
  linesArb,
  maxLineTotalsArb,
  MAX_TAX_RATE_BPS,
  percentBpsArb,
  taxRateArb,
} from './__test__/arbitraries';
import { CURRENCY, lineInput, NOW, USER, WORKSPACE } from './__test__/builders';
import { DiscountType } from './discount';
import { Order } from './order';
import { calculateTotals } from './order-totals';

import type { Discount } from './discount';

interface Totals {
  subtotal: bigint;
  discount: bigint;
  tax: bigint;
  total: bigint;
}

/** Totals as plain minor units, so a counterexample shows all four numbers at once. */
function totals(lineTotals: readonly bigint[], discount: Discount, taxRateBps: number): Totals {
  const t = calculateTotals({
    currency: CURRENCY,
    lineTotals: lineTotals.map((minor) => Money.of(minor, CURRENCY)),
    discount,
    taxRateBps,
  });
  return {
    subtotal: t.subtotal.amountMinor,
    discount: t.discount.amountMinor,
    tax: t.tax.amountMinor,
    total: t.total.amountMinor,
  };
}

/**
 * Independent reference implementation of docs/requirements.md → CALC, on bare bigint.
 * Rounds via quotient + remainder, not via the formula `Money` uses, so a shared mistake
 * in both is unlikely.
 */
function oracleRoundHalfUp(n: bigint, d: bigint): bigint {
  const q = n / d;
  return 2n * (n % d) >= d ? q + 1n : q;
}

function oracle(lineTotals: readonly bigint[], discount: Discount, taxRateBps: number): Totals {
  const subtotal = lineTotals.reduce((sum, line) => sum + line, 0n);
  let disc: bigint;
  switch (discount.type) {
    case DiscountType.None:
      disc = 0n;
      break;
    case DiscountType.Percent:
      disc = oracleRoundHalfUp(subtotal * BigInt(discount.valueBps), 10_000n);
      break;
    case DiscountType.Fixed:
      disc = discount.valueMinor < subtotal ? discount.valueMinor : subtotal;
      break;
  }
  const taxable = subtotal - disc;
  const tax = oracleRoundHalfUp(taxable * BigInt(taxRateBps), 10_000n);
  return { subtotal, discount: disc, tax, total: taxable + tax };
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** Two values of one arbitrary, ascending. */
const orderedPair = <T extends number | bigint>(arb: fc.Arbitrary<T>): fc.Arbitrary<[T, T]> =>
  fc.tuple(arb, arb).map(([a, b]): [T, T] => (a <= b ? [a, b] : [b, a]));

describe('calculateTotals properties', () => {
  it('CALC-008 0 ≤ discount ≤ subtotal', () => {
    fc.assert(
      fc.property(lineTotalsArb, discountArb, taxRateArb, (lines, discount, tax) => {
        const t = totals(lines, discount, tax);
        expect(t.discount).toBeGreaterThanOrEqual(0n);
        expect(t.discount).toBeLessThanOrEqual(t.subtotal);
      }),
    );
  });

  it('CALC-009 total ≥ 0', () => {
    fc.assert(
      fc.property(lineTotalsArb, discountArb, taxRateArb, (lines, discount, tax) => {
        expect(totals(lines, discount, tax).total).toBeGreaterThanOrEqual(0n);
      }),
    );
  });

  it('CALC-010 subtotal = Σ lineTotal', () => {
    fc.assert(
      fc.property(lineTotalsArb, discountArb, taxRateArb, (lines, discount, tax) => {
        const sum = lines.reduce((acc, line) => acc + line, 0n);
        expect(totals(lines, discount, tax).subtotal).toBe(sum);
      }),
    );
  });

  it('CALC-011 total = subtotal − discount + tax', () => {
    fc.assert(
      fc.property(lineTotalsArb, discountArb, taxRateArb, (lines, discount, tax) => {
        const t = totals(lines, discount, tax);
        expect(t.total).toBe(t.subtotal - t.discount + t.tax);
      }),
    );
  });

  it('the order of the lines does not change the totals', () => {
    const linesAndPermutation = lineTotalsArb.chain((lines) =>
      fc.tuple(
        fc.constant(lines),
        fc.shuffledSubarray(lines, { minLength: lines.length, maxLength: lines.length }),
      ),
    );
    fc.assert(
      fc.property(
        linesAndPermutation,
        discountArb,
        taxRateArb,
        ([lines, shuffled], discount, tax) => {
          expect(totals(shuffled, discount, tax)).toEqual(totals(lines, discount, tax));
        },
      ),
    );
  });

  it('CALC-002…007 match an independent implementation of the formulas', () => {
    fc.assert(
      fc.property(lineTotalsArb, discountArb, taxRateArb, (lines, discount, tax) => {
        expect(totals(lines, discount, tax)).toEqual(oracle(lines, discount, tax));
      }),
    );
  });

  it('50 lines × max price × max quantity stay exact beyond Number.MAX_SAFE_INTEGER', () => {
    fc.assert(
      fc.property(maxLineTotalsArb, discountArb, (lines, discount) => {
        expect(totals(lines, discount, MAX_TAX_RATE_BPS)).toEqual(
          oracle(lines, discount, MAX_TAX_RATE_BPS),
        );
      }),
    );
  });

  describe('rounding is off by at most half a minor unit', () => {
    it('CALC-004 PERCENT discount', () => {
      fc.assert(
        fc.property(lineTotalsArb, percentBpsArb, (lines, valueBps) => {
          const t = totals(lines, { type: DiscountType.Percent, valueBps }, 0);
          expect(abs(t.discount * 10_000n - t.subtotal * BigInt(valueBps))).toBeLessThanOrEqual(
            5000n,
          );
        }),
      );
    });

    it('CALC-006 tax', () => {
      fc.assert(
        fc.property(lineTotalsArb, discountArb, taxRateArb, (lines, discount, tax) => {
          const t = totals(lines, discount, tax);
          const taxable = t.subtotal - t.discount;
          expect(abs(t.tax * 10_000n - taxable * BigInt(tax))).toBeLessThanOrEqual(5000n);
        }),
      );
    });
  });

  describe('monotonicity', () => {
    it('a larger PERCENT discount never raises the total', () => {
      fc.assert(
        fc.property(
          lineTotalsArb,
          orderedPair(percentBpsArb),
          taxRateArb,
          (lines, [low, high], tax) => {
            const withLow = totals(lines, { type: DiscountType.Percent, valueBps: low }, tax);
            const withHigh = totals(lines, { type: DiscountType.Percent, valueBps: high }, tax);
            expect(withHigh.total).toBeLessThanOrEqual(withLow.total);
          },
        ),
      );
    });

    it('a larger FIXED discount never raises the total', () => {
      fc.assert(
        fc.property(
          lineTotalsArb,
          orderedPair(fixedMinorArb),
          taxRateArb,
          (lines, [low, high], tax) => {
            const withLow = totals(lines, { type: DiscountType.Fixed, valueMinor: low }, tax);
            const withHigh = totals(lines, { type: DiscountType.Fixed, valueMinor: high }, tax);
            expect(withHigh.total).toBeLessThanOrEqual(withLow.total);
          },
        ),
      );
    });

    it('a higher tax rate never lowers the total', () => {
      fc.assert(
        fc.property(
          lineTotalsArb,
          discountArb,
          orderedPair(taxRateArb),
          (lines, discount, [low, high]) => {
            expect(totals(lines, discount, high).total).toBeGreaterThanOrEqual(
              totals(lines, discount, low).total,
            );
          },
        ),
      );
    });
  });
});

describe('Order totals properties', () => {
  it('CALC-010 the subtotal of a drafted order is Σ unitPrice × quantity of its stored lines', () => {
    fc.assert(
      fc.property(linesArb, discountArb, taxRateArb, (specs, discount, taxRateBps) => {
        const order = Order.draft({
          workspaceId: WORKSPACE,
          currency: CURRENCY,
          taxRateBps,
          discount,
          createdBy: USER,
          now: NOW,
          lines: specs.map((spec, i) =>
            lineInput({ ...spec, productId: `product-${i}`, sku: `SKU-${i}` }),
          ),
        });
        const stored = order.snapshot().lines.map((line) => line.snapshot());
        const expected = stored.reduce(
          (sum, line) => sum + line.unitPrice.amountMinor * BigInt(line.quantity),
          0n,
        );
        expect(order.totals.subtotal.amountMinor).toBe(expected);
        expect(stored.map((l) => [l.unitPrice.amountMinor, l.quantity])).toEqual(
          specs.map((s) => [s.unitPriceMinor, s.quantity]),
        );
      }),
    );
  });
});
