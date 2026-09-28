import fc from 'fast-check';

import { DiscountType, MAX_PERCENT_BPS, NO_DISCOUNT } from '../discount';
import { MAX_LINES } from '../order';
import { MAX_QUANTITY, MIN_QUANTITY } from '../order-line';

import type { Discount } from '../discount';

/** Mirrors `MIN_PRICE_MINOR` / `MAX_PRICE_MINOR` in catalog.dto.ts (another module, not imported here). */
export const MIN_PRICE_MINOR = 1n;
export const MAX_PRICE_MINOR = 100_000_000n;
/** Mirrors `@Max(5000)` on `taxRateBps` in identity.dto.ts. */
export const MAX_TAX_RATE_BPS = 5000;

/** The largest subtotal an order can reach: 50 lines × max price × max quantity = 5·10¹². */
export const MAX_SUBTOTAL_MINOR = MAX_PRICE_MINOR * BigInt(MAX_QUANTITY) * BigInt(MAX_LINES);

export interface LineSpec {
  unitPriceMinor: bigint;
  quantity: number;
}

export const lineArb: fc.Arbitrary<LineSpec> = fc.record({
  unitPriceMinor: fc.bigInt({ min: MIN_PRICE_MINOR, max: MAX_PRICE_MINOR }),
  quantity: fc.integer({ min: MIN_QUANTITY, max: MAX_QUANTITY }),
});

/** 0…50 lines; an order with no items is valid (CALC-002). */
export const linesArb: fc.Arbitrary<LineSpec[]> = fc.array(lineArb, { maxLength: MAX_LINES });

export const lineTotalsArb: fc.Arbitrary<bigint[]> = linesArb.map((lines) =>
  lines.map((l) => l.unitPriceMinor * BigInt(l.quantity)),
);

export const percentBpsArb = fc.integer({ min: 0, max: MAX_PERCENT_BPS });

/** Up to twice the largest subtotal, so FIXED often exceeds the subtotal and hits `min`. */
export const fixedMinorArb = fc.bigInt({ min: 0n, max: MAX_SUBTOTAL_MINOR * 2n });

export const discountArb: fc.Arbitrary<Discount> = fc.oneof(
  fc.constant(NO_DISCOUNT),
  percentBpsArb.map((valueBps): Discount => ({ type: DiscountType.Percent, valueBps })),
  fixedMinorArb.map((valueMinor): Discount => ({ type: DiscountType.Fixed, valueMinor })),
);

export const taxRateArb = fc.integer({ min: 0, max: MAX_TAX_RATE_BPS });

/** The roadmap edge case: 50 lines at max price × max quantity. */
export const maxLineTotalsArb: fc.Arbitrary<bigint[]> = fc.constant(
  Array.from({ length: MAX_LINES }, () => MAX_PRICE_MINOR * BigInt(MAX_QUANTITY)),
);
