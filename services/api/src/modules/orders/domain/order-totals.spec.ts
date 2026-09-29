import { describe, expect, it } from 'vitest';

import { Money } from '@shared/domain/money';

import { DiscountType, NO_DISCOUNT } from './discount';
import { calculateTotals, lineTotal } from './order-totals';

import type { Discount } from './discount';

const TAX = 2000;
const eur = (minor: bigint): Money => Money.of(minor, 'EUR');
const percent = (valueBps: number): Discount => ({ type: DiscountType.Percent, valueBps });
const fixed = (valueMinor: bigint): Discount => ({ type: DiscountType.Fixed, valueMinor });

/** Totals as plain minor units, so a failure shows all four numbers at once. */
function totals(lineTotals: readonly bigint[], discount: Discount, taxRateBps: number) {
  const t = calculateTotals({
    currency: 'EUR',
    lineTotals: lineTotals.map(eur),
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

describe('lineTotal', () => {
  it('CALC-001 is unit price × quantity', () => {
    expect(lineTotal(eur(1250n), 3).amountMinor).toBe(3750n);
    expect(lineTotal(eur(1250n), 1).amountMinor).toBe(1250n);
  });
});

describe('calculateTotals', () => {
  describe('subtotal', () => {
    it('CALC-002 is the sum of the line totals', () => {
      expect(totals([100n, 250n, 1n], NO_DISCOUNT, 0).subtotal).toBe(351n);
    });

    it('CALC-002 is 0 for an order with no items, and so is everything else', () => {
      expect(totals([], NO_DISCOUNT, TAX)).toEqual({
        subtotal: 0n,
        discount: 0n,
        tax: 0n,
        total: 0n,
      });
    });

    it('keeps the order currency', () => {
      const t = calculateTotals({
        currency: 'USD',
        lineTotals: [],
        discount: NO_DISCOUNT,
        taxRateBps: 0,
      });
      expect(t.total.currency).toBe('USD');
    });
  });

  describe('discount', () => {
    it('CALC-003 NONE gives no discount', () => {
      expect(totals([3750n], NO_DISCOUNT, 0).discount).toBe(0n);
    });

    it.each([
      [3750n, 1000, 375n],
      [3750n, 0, 0n],
      [3750n, 10_000, 3750n],
      [3n, 5000, 2n], // 1.5 → 2
      [10_001n, 5000, 5001n], // 5000.5 → 5001
      [1n, 4999, 0n], // 0.4999 → 0
    ])('CALC-004 PERCENT of %s at %s bps is %s, rounded half up', (subtotal, bps, expected) => {
      expect(totals([subtotal], percent(bps), 0).discount).toBe(expected);
    });

    it.each([
      [3750n, 500n, 500n],
      [3750n, 3750n, 3750n],
      [3750n, 9999n, 3750n],
      [3750n, 0n, 0n],
      [0n, 100n, 0n],
    ])(
      'CALC-005 FIXED on %s of %s is %s: never more than the subtotal',
      (subtotal, value, expected) => {
        expect(totals([subtotal], fixed(value), 0).discount).toBe(expected);
      },
    );
  });

  describe('tax and total', () => {
    it('CALC-006 taxes the subtotal after the discount', () => {
      // taxable = 1000 − 500 = 500; 20 % of 500 = 100
      expect(totals([1000n], fixed(500n), 2000).tax).toBe(100n);
    });

    it.each([
      [598n, 2000, 120n], // 119.6 → 120
      [5n, 1000, 1n], // 0.5 → 1
      [4n, 1000, 0n], // 0.4 → 0
      [598n, 0, 0n],
    ])('CALC-006 tax on %s at %s bps is %s, rounded half up', (taxable, bps, expected) => {
      expect(totals([taxable], NO_DISCOUNT, bps).tax).toBe(expected);
    });

    it('CALC-007 total is the taxable amount plus tax', () => {
      // taxable = 1000 − 100 = 900; tax = 180
      expect(totals([1000n], fixed(100n), 2000).total).toBe(1080n);
    });
  });

  describe('examples from the requirements', () => {
    it.each([
      {
        name: '3 × 1250, PERCENT 1000, tax 2000',
        lines: [lineTotal(eur(1250n), 3).amountMinor],
        discount: percent(1000),
        tax: 2000,
        expected: { subtotal: 3750n, discount: 375n, tax: 675n, total: 4050n },
      },
      {
        name: '2 × 299, no discount, tax 2000',
        lines: [lineTotal(eur(299n), 2).amountMinor],
        discount: NO_DISCOUNT,
        tax: 2000,
        expected: { subtotal: 598n, discount: 0n, tax: 120n, total: 718n },
      },
      {
        name: 'PERCENT 5000 of subtotal 3',
        lines: [3n],
        discount: percent(5000),
        tax: 0,
        expected: { subtotal: 3n, discount: 2n, tax: 0n, total: 1n },
      },
    ])('CALC-015 $name', ({ lines, discount, tax, expected }) => {
      expect(totals(lines, discount, tax)).toEqual(expected);
    });
  });

  describe('invariants at the edges', () => {
    it('CALC-008 a 100 % discount equals the subtotal', () => {
      const t = totals([3750n], percent(10_000), TAX);
      expect(t.discount).toBe(t.subtotal);
    });

    it('CALC-009 total is 0, not negative, when the discount covers everything', () => {
      expect(totals([3750n], fixed(1_000_000n), TAX).total).toBe(0n);
      expect(totals([3750n], percent(10_000), TAX).total).toBe(0n);
    });
  });
});
