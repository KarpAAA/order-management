import { describe, expect, it } from 'vitest';

import { DiscountType } from '@modules/orders/domain/discount';
import { OrderProductNotFoundError, ProductNotActiveError } from '@modules/orders/domain/errors';
import { OrderStatus } from '@modules/orders/domain/order-status';

import {
  PRODUCT_ACME_ARCHIVED,
  PRODUCT_GLOBEX_ACTIVE,
  USER_ACME_MEMBER,
  WS_ACME,
  WS_GLOBEX,
} from '../seed/ids';
import { testDb } from '../setup/db';

import { membershipFactory, orderFactory, productFactory, userFactory, workspaceFactory } from '.';

describe('row factories', () => {
  it('owns its rows: the same SKU as another file does not collide', async () => {
    await productFactory.create({ sku: 'ISOLATION-1' });
    expect(await testDb().product.count({ where: { sku: 'ISOLATION-1' } })).toBe(1);
  });

  it('build() stays in memory, create() persists', async () => {
    const built = productFactory.build();
    const created = await productFactory.create({ status: 'ARCHIVED' });
    expect(await testDb().product.findFirst({ where: { id: built.id } })).toBeNull();
    expect(await testDb().product.findFirst({ where: { id: created.id } })).toMatchObject({
      status: 'ARCHIVED',
      workspaceId: WS_ACME,
    });
  });

  it('builds a third tenant with its own member', async () => {
    const workspace = await workspaceFactory.create();
    const user = await userFactory.create();
    await membershipFactory.create({ workspaceId: workspace.id, userId: user.id, role: 'OWNER' });

    const member = await testDb().membership.findFirstOrThrow({ where: { userId: user.id } });
    expect(member).toMatchObject({ workspaceId: workspace.id, role: 'OWNER' });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('refuses a membership without a user', async () => {
    await expect(membershipFactory.create()).rejects.toThrow(/userId/);
  });
});

describe('orderFactory', () => {
  it('persists totals computed by the domain', async () => {
    const product = await productFactory.create({ priceMinor: 1250n });
    const order = await orderFactory.create({
      lines: [{ productId: product.id, quantity: 3 }],
      discount: { type: DiscountType.Percent, valueBps: 1000 },
    });
    // CALC-015: 3 × 1250 EUR, 10 % off, 20 % tax → 3750 / 375 / 675 / 4050
    const row = await testDb().order.findFirstOrThrow({ where: { id: order.id } });
    expect(row).toMatchObject({
      workspaceId: WS_ACME,
      currency: 'EUR',
      subtotalMinor: 3750n,
      discountMinor: 375n,
      taxMinor: 675n,
      totalMinor: 4050n,
      createdBy: USER_ACME_MEMBER,
    });
    expect(await testDb().orderItem.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('reaches a status through the real transitions, with matching history', async () => {
    const order = await orderFactory.create({ status: OrderStatus.Paid });
    const row = await testDb().order.findFirstOrThrow({ where: { id: order.id } });
    expect(row).toMatchObject({ status: 'PAID', paymentAttempt: 1 });
    expect(row.placedAt).not.toBeNull();
    expect(row.paidAt).not.toBeNull();

    const events = await testDb().orderEvent.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([
      ['ORDER_CREATED', null, 'DRAFT'],
      ['ORDER_PLACED', 'DRAFT', 'PENDING_PAYMENT'],
      ['PAYMENT_SUCCEEDED', 'PENDING_PAYMENT', 'PAID'],
    ]);
  });

  it('uses the workspace terms and seeded product of globex', async () => {
    const order = await orderFactory.create({
      workspaceId: WS_GLOBEX,
      status: OrderStatus.Fulfilled,
    });
    const row = await testDb().order.findFirstOrThrow({ where: { id: order.id } });
    expect(row).toMatchObject({ currency: 'USD', taxRateBps: 0, status: 'FULFILLED' });
    const [item] = await testDb().orderItem.findMany({ where: { orderId: order.id } });
    expect(item?.productId).toBe(PRODUCT_GLOBEX_ACTIVE);
  });

  it("cannot use another workspace's product", async () => {
    await expect(
      orderFactory.create({ lines: [{ productId: PRODUCT_GLOBEX_ACTIVE, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(OrderProductNotFoundError);
  });

  it('cannot create an order the app could not: archived product', async () => {
    await expect(
      orderFactory.create({ lines: [{ productId: PRODUCT_ACME_ARCHIVED, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(ProductNotActiveError);
  });
});
