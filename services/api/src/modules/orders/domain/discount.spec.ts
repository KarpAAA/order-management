import { describe, expect, it } from 'vitest';

import { DiscountType, discountOf, NO_DISCOUNT } from './discount';
import { InvalidOrderError } from './errors';

type DiscountInput = Parameters<typeof discountOf>[0];

describe('discountOf', () => {
  it('ORD-007 NONE without a value is no discount', () => {
    expect(discountOf({ type: DiscountType.None })).toEqual(NO_DISCOUNT);
  });

  it.each([0, 1, 10_000])('ORD-007 PERCENT accepts valueBps %s', (valueBps) => {
    expect(discountOf({ type: DiscountType.Percent, valueBps })).toEqual({
      type: DiscountType.Percent,
      valueBps,
    });
  });

  it.each([0n, 1n, 2n ** 53n - 1n])('ORD-007 FIXED accepts valueMinor %s', (valueMinor) => {
    expect(discountOf({ type: DiscountType.Fixed, valueMinor })).toEqual({
      type: DiscountType.Fixed,
      valueMinor,
    });
  });

  it.each<[string, DiscountInput]>([
    ['NONE with valueBps', { type: DiscountType.None, valueBps: 10 }],
    ['NONE with valueMinor', { type: DiscountType.None, valueMinor: 1n }],
    ['PERCENT without valueBps', { type: DiscountType.Percent }],
    ['PERCENT with a fractional valueBps', { type: DiscountType.Percent, valueBps: 1.5 }],
    ['PERCENT below 0', { type: DiscountType.Percent, valueBps: -1 }],
    ['PERCENT above 10000', { type: DiscountType.Percent, valueBps: 10_001 }],
    ['PERCENT with valueMinor', { type: DiscountType.Percent, valueBps: 10, valueMinor: 1n }],
    ['FIXED without valueMinor', { type: DiscountType.Fixed }],
    ['FIXED below 0', { type: DiscountType.Fixed, valueMinor: -1n }],
    ['FIXED with valueBps', { type: DiscountType.Fixed, valueMinor: 1n, valueBps: 10 }],
  ])('ORD-007 rejects %s', (_case, input) => {
    expect(() => discountOf(input)).toThrow(InvalidOrderError);
  });
});
