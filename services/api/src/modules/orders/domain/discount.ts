import { InvalidOrderError } from './errors';

/** Mirrors the Prisma enum `DiscountType`. */
export enum DiscountType {
  None = 'NONE',
  Percent = 'PERCENT',
  Fixed = 'FIXED',
}

export const MAX_PERCENT_BPS = 10_000;

export type Discount =
  | { readonly type: DiscountType.None }
  | { readonly type: DiscountType.Percent; readonly valueBps: number }
  | { readonly type: DiscountType.Fixed; readonly valueMinor: bigint };

export const NO_DISCOUNT: Discount = { type: DiscountType.None };

/** Validating factory for a discount coming from outside (a command). */
export function discountOf(input: {
  type: DiscountType;
  valueBps?: number | undefined;
  valueMinor?: bigint | undefined;
}): Discount {
  switch (input.type) {
    case DiscountType.None:
      if (input.valueBps !== undefined || input.valueMinor !== undefined) {
        throw new InvalidOrderError('NONE discount takes no value', {});
      }
      return NO_DISCOUNT;
    case DiscountType.Percent: {
      const { valueBps } = input;
      if (input.valueMinor !== undefined) {
        throw new InvalidOrderError('PERCENT discount takes valueBps, not valueMinor', {});
      }
      if (valueBps === undefined || !Number.isInteger(valueBps)) {
        throw new InvalidOrderError('PERCENT discount needs an integer valueBps', {});
      }
      if (valueBps < 0 || valueBps > MAX_PERCENT_BPS) {
        throw new InvalidOrderError('valueBps must be within 0..10000', { valueBps });
      }
      return { type: DiscountType.Percent, valueBps };
    }
    case DiscountType.Fixed: {
      const { valueMinor } = input;
      if (input.valueBps !== undefined) {
        throw new InvalidOrderError('FIXED discount takes valueMinor, not valueBps', {});
      }
      if (valueMinor === undefined || valueMinor < 0n) {
        throw new InvalidOrderError('FIXED discount needs valueMinor >= 0', {});
      }
      return { type: DiscountType.Fixed, valueMinor };
    }
  }
}
