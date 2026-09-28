import { describe, expect, it } from 'vitest';

import { Money } from '@shared/domain/money';

import { InvalidOrderError } from './errors';
import { OrderLine } from './order-line';

const create = (quantity: number): OrderLine =>
  OrderLine.create({
    position: 0,
    productId: 'product-1',
    sku: 'SKU-1',
    name: 'Product 1',
    unitPrice: Money.of(1250n, 'EUR'),
    quantity,
  });

describe('OrderLine.create', () => {
  it.each([1, 1000])('ORD-003 accepts quantity %s', (quantity) => {
    expect(create(quantity).quantity).toBe(quantity);
  });

  it.each([0, -1, 1001, 1.5])('ORD-003 rejects quantity %s', (quantity) => {
    expect(() => create(quantity)).toThrow(InvalidOrderError);
  });

  it('CALC-001 its total is unit price × quantity', () => {
    expect(create(3).total.amountMinor).toBe(3750n);
  });
});
