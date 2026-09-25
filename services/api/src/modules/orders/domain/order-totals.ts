import { Money } from '@shared/domain/money';

import { DiscountType } from './discount';

import type { Discount } from './discount';

export interface OrderTotals {
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly total: Money;
}

/**
 * Pure, integer-only order arithmetic (docs/requirements.md → Calculations):
 *
 *   lineTotal = unitPrice × quantity
 *   subtotal  = Σ lineTotal
 *   discount  = PERCENT → roundHalfUp(subtotal × valueBps / 10000)
 *               FIXED   → min(valueMinor, subtotal)
 *   taxable   = subtotal − discount
 *   tax       = roundHalfUp(taxable × taxRateBps / 10000)
 *   total     = taxable + tax
 *
 * Invariants: 0 ≤ discount ≤ subtotal, total ≥ 0, subtotal = Σ lineTotal.
 */
export function calculateTotals(input: {
  currency: string;
  lineTotals: readonly Money[];
  discount: Discount;
  taxRateBps: number;
}): OrderTotals {
  const subtotal = input.lineTotals.reduce(
    (sum, line) => sum.add(line),
    Money.zero(input.currency),
  );
  const discount = discountAmount(subtotal, input.discount);
  const taxable = subtotal.subtract(discount);
  const tax = taxable.basisPoints(input.taxRateBps);
  return { subtotal, discount, tax, total: taxable.add(tax) };
}

export function lineTotal(unitPrice: Money, quantity: number): Money {
  return unitPrice.multiply(quantity);
}

function discountAmount(subtotal: Money, discount: Discount): Money {
  switch (discount.type) {
    case DiscountType.None:
      return Money.zero(subtotal.currency);
    case DiscountType.Percent:
      // valueBps ≤ 10 000, so the rounded result never exceeds the subtotal
      return subtotal.basisPoints(discount.valueBps);
    case DiscountType.Fixed:
      return Money.of(discount.valueMinor, subtotal.currency).min(subtotal);
  }
}
