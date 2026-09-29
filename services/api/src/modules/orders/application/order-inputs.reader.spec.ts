import { describe, expect, it } from 'vitest';

import { PRODUCT_1, PRODUCT_2 } from '../domain/__test__/builders';

import {
  ACTIVE_PRODUCT,
  ARCHIVED_PRODUCT,
  FakeCatalog,
  readerOver,
} from './__test__/order-inputs.fakes';

describe('OrderInputsReader.lines', () => {
  it('ORD-002 asks the catalog nothing for an order without items', async () => {
    const catalog = new FakeCatalog([ACTIVE_PRODUCT]);

    expect(await readerOver(catalog).lines([])).toEqual([]);
    expect(catalog.requests).toEqual([]);
  });

  it('CALC-014 snapshots sku, name, price and status of each product, in the given order', async () => {
    const lines = await readerOver().lines([
      { productId: PRODUCT_2, quantity: 1 },
      { productId: PRODUCT_1, quantity: 3 },
    ]);

    expect(lines).toEqual([
      {
        productId: PRODUCT_2,
        sku: 'SKU-2',
        name: 'Product 2',
        unitPriceMinor: 990n,
        isActive: false,
        quantity: 1,
      },
      {
        productId: PRODUCT_1,
        sku: 'SKU-1',
        name: 'Product 1',
        unitPriceMinor: 1250n,
        isActive: true,
        quantity: 3,
      },
    ]);
  });

  it('asks the catalog once per product, even when an item repeats', async () => {
    const catalog = new FakeCatalog([ACTIVE_PRODUCT, ARCHIVED_PRODUCT]);

    await readerOver(catalog).lines([
      { productId: PRODUCT_1, quantity: 1 },
      { productId: PRODUCT_1, quantity: 2 },
    ]);

    expect(catalog.requests).toEqual([[PRODUCT_1]]);
  });

  it('ORD-005 reports an unknown product as PRODUCT_NOT_FOUND, naming it', async () => {
    await expect(readerOver().lines([{ productId: 'unknown', quantity: 1 }])).rejects.toThrow(
      expect.objectContaining({ code: 'PRODUCT_NOT_FOUND', details: { productId: 'unknown' } }),
    );
  });
});
