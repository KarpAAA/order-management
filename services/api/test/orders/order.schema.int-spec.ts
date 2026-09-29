// CALC-011: the database itself refuses amounts that do not add up (hand-written CHECKs in
// the init migration). The subject is the schema, so the test writes raw rows via testDb():
// the app would never send such a row — this is the net under a future bug.
import { describe, expect, it } from 'vitest';

import { OrderStatus } from '@modules/orders/domain/order-status';

import { orderFactory } from '../factories';
import { testDb } from '../setup/db';

describe('orders table CHECKs (CALC-011)', () => {
  it('rejects a total that is not subtotal − discount + tax', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });
    const row = await testDb().order.findFirstOrThrow({ where: { id } });

    await expect(
      testDb().order.updateMany({ where: { id }, data: { totalMinor: row.totalMinor + 1n } }),
    ).rejects.toThrow(/orders_amounts_chk/);
  });

  it('rejects a discount larger than the subtotal', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });
    const row = await testDb().order.findFirstOrThrow({ where: { id } });

    await expect(
      testDb().order.updateMany({
        where: { id },
        data: { discountMinor: row.subtotalMinor + 1n, totalMinor: row.taxMinor - 1n },
      }),
    ).rejects.toThrow(/orders_amounts_chk/);
  });
});

describe('order_items table CHECKs', () => {
  it('rejects a line total that is not unit price × quantity', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });

    await expect(
      testDb().orderItem.updateMany({
        where: { orderId: id },
        data: { quantity: { increment: 1 } },
      }),
    ).rejects.toThrow(/order_items_line_total_chk/);
  });
});
