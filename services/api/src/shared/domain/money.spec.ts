import { describe, expect, it } from 'vitest';

import { CurrencyMismatchError, InvalidMoneyError, Money, roundHalfUp } from './money';

const eur = (minor: bigint): Money => Money.of(minor, 'EUR');
const usd = (minor: bigint): Money => Money.of(minor, 'USD');

describe('roundHalfUp', () => {
  it.each([
    [5n, 2n, 3n], // 2.5
    [4n, 2n, 2n], // 2.0
    [15n, 10n, 2n], // 1.5
    [14n, 10n, 1n], // 1.4
    [149n, 100n, 1n], // 1.49
    [150n, 100n, 2n], // 1.50
    [0n, 7n, 0n],
  ])('rounds %s / %s to %s, a half goes up', (numerator, denominator, expected) => {
    expect(roundHalfUp(numerator, denominator)).toBe(expected);
  });

  it('rounds a negative half away from zero', () => {
    expect(roundHalfUp(-5n, 2n)).toBe(-3n);
    expect(roundHalfUp(-14n, 10n)).toBe(-1n);
  });

  it.each([0n, -1n])('rejects the denominator %s', (denominator) => {
    expect(() => roundHalfUp(1n, denominator)).toThrow(InvalidMoneyError);
  });
});

describe('Money.of', () => {
  it('keeps the amount in minor units and the currency', () => {
    const money = eur(1250n);
    expect(money.amountMinor).toBe(1250n);
    expect(money.currency).toBe('EUR');
  });

  it.each(['eur', 'EU', 'EURO', ''])('rejects the currency "%s" (not ISO 4217)', (currency) => {
    expect(() => Money.of(1n, currency)).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts amounts of one currency', () => {
    expect(eur(100n).add(eur(25n)).amountMinor).toBe(125n);
    expect(eur(100n).subtract(eur(25n)).amountMinor).toBe(75n);
  });

  it('picks the smaller amount', () => {
    expect(eur(100n).min(eur(25n)).amountMinor).toBe(25n);
    expect(eur(25n).min(eur(100n)).amountMinor).toBe(25n);
  });

  it('never combines two currencies', () => {
    expect(() => eur(1n).add(usd(1n))).toThrow(CurrencyMismatchError);
    expect(() => eur(1n).subtract(usd(1n))).toThrow(CurrencyMismatchError);
    expect(() => eur(1n).min(usd(1n))).toThrow(CurrencyMismatchError);
  });

  it('CALC-001 multiplies by an integer quantity', () => {
    expect(eur(1250n).multiply(3).amountMinor).toBe(3750n);
  });

  it.each([1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects the factor %s', (factor) => {
    expect(() => eur(1n).multiply(factor)).toThrow(InvalidMoneyError);
  });

  it('stays exact beyond Number.MAX_SAFE_INTEGER', () => {
    const big = eur(BigInt(Number.MAX_SAFE_INTEGER));
    expect(big.multiply(1000).amountMinor).toBe(BigInt(Number.MAX_SAFE_INTEGER) * 1000n);
  });

  it('knows when it is negative', () => {
    expect(eur(1n).subtract(eur(2n)).isNegative()).toBe(true);
    expect(eur(0n).isNegative()).toBe(false);
  });

  it('equals money with the same amount and currency only', () => {
    expect(eur(1n).equals(eur(1n))).toBe(true);
    expect(eur(1n).equals(eur(2n))).toBe(false);
    expect(eur(1n).equals(usd(1n))).toBe(false);
  });
});

describe('Money.basisPoints', () => {
  it.each([
    [3750n, 1000, 375n], // 10 %
    [3750n, 0, 0n],
    [3750n, 10_000, 3750n], // 100 %
    [3n, 5000, 2n], // 1.5 → 2
    [598n, 2000, 120n], // 119.6 → 120
    [1n, 4999, 0n], // 0.4999 → 0
  ])('%s at %s bps is %s, rounded half up', (amount, bps, expected) => {
    expect(eur(amount).basisPoints(bps).amountMinor).toBe(expected);
  });

  it('rejects fractional basis points', () => {
    expect(() => eur(1n).basisPoints(1.5)).toThrow(InvalidMoneyError);
  });
});
