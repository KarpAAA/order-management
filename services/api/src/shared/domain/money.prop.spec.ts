import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CurrencyMismatchError, Money, roundHalfUp } from './money';

// Well past 2⁵³ in both directions, so any Number-based shortcut would show.
const amountArb = fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n });
const nonNegativeArb = fc.bigInt({ min: 0n, max: 10n ** 20n });
const eurArb = amountArb.map((minor) => Money.of(minor, 'EUR'));
const bpsArb = fc.integer({ min: 0, max: 10_000 });

describe('roundHalfUp properties', () => {
  const denominatorArb = fc.bigInt({ min: 1n, max: 10n ** 12n });

  it('is off by at most half: |result × d − n| × 2 ≤ d', () => {
    fc.assert(
      fc.property(amountArb, denominatorArb, (n, d) => {
        const diff = roundHalfUp(n, d) * d - n;
        expect((diff < 0n ? -diff : diff) * 2n).toBeLessThanOrEqual(d);
      }),
    );
  });

  it('matches quotient + remainder rounding for non-negative numerators', () => {
    fc.assert(
      fc.property(nonNegativeArb, denominatorArb, (n, d) => {
        const expected = 2n * (n % d) >= d ? n / d + 1n : n / d;
        expect(roundHalfUp(n, d)).toBe(expected);
      }),
    );
  });

  it('is symmetric around zero: f(−n) = −f(n)', () => {
    fc.assert(
      fc.property(amountArb, denominatorArb, (n, d) => {
        expect(roundHalfUp(-n, d)).toBe(-roundHalfUp(n, d));
      }),
    );
  });
});

describe('Money properties', () => {
  it('add is commutative and associative', () => {
    fc.assert(
      fc.property(eurArb, eurArb, eurArb, (a, b, c) => {
        expect(a.add(b).equals(b.add(a))).toBe(true);
        expect(
          a
            .add(b)
            .add(c)
            .equals(a.add(b.add(c))),
        ).toBe(true);
      }),
    );
  });

  it('subtract undoes add', () => {
    fc.assert(
      fc.property(eurArb, eurArb, (a, b) => {
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
      }),
    );
  });

  it('min returns one of its arguments and is ≤ both', () => {
    fc.assert(
      fc.property(eurArb, eurArb, (a, b) => {
        const m = a.min(b);
        expect(m === a || m === b).toBe(true);
        expect(m.amountMinor).toBeLessThanOrEqual(a.amountMinor);
        expect(m.amountMinor).toBeLessThanOrEqual(b.amountMinor);
      }),
    );
  });

  it('never combines two currencies', () => {
    const pairArb = fc
      .tuple(
        fc.constantFrom('EUR', 'USD', 'UAH', 'GBP'),
        fc.constantFrom('EUR', 'USD', 'UAH', 'GBP'),
      )
      .filter(([x, y]) => x !== y);
    fc.assert(
      fc.property(amountArb, amountArb, pairArb, (x, y, [left, right]) => {
        const a = Money.of(x, left);
        const b = Money.of(y, right);
        expect(() => a.add(b)).toThrow(CurrencyMismatchError);
        expect(() => a.subtract(b)).toThrow(CurrencyMismatchError);
        expect(() => a.min(b)).toThrow(CurrencyMismatchError);
      }),
    );
  });

  it('basisPoints: 0 bps is zero, 10 000 bps is the amount, anything between stays within 0…amount', () => {
    fc.assert(
      fc.property(nonNegativeArb, bpsArb, (minor, bps) => {
        const money = Money.of(minor, 'EUR');
        expect(money.basisPoints(0).amountMinor).toBe(0n);
        expect(money.basisPoints(10_000).amountMinor).toBe(minor);
        const part = money.basisPoints(bps).amountMinor;
        expect(part).toBeGreaterThanOrEqual(0n);
        expect(part).toBeLessThanOrEqual(minor);
      }),
    );
  });
});
