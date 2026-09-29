// The order API end to end: create → edit → place → pay (factory) → fulfill / cancel.
// Arrange with factories, act only through HTTP, check "nothing else changed" in the database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  membershipFactory,
  orderFactory,
  productFactory,
  userFactory,
  workspaceFactory,
} from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { orderPath, ordersPath, productPath } from '../helpers/paths';
import {
  USER_ACME_ADMIN,
  USER_ACME_MEMBER,
  WS_ACME,
  WS_GLOBEX,
  USER_GLOBEX_MEMBER,
} from '../seed/ids';
import { testDb } from '../setup/db';

let api: ApiApp;
beforeAll(async () => {
  api = await createApiApp();
});
afterAll(() => api.close());

const member = asUser(USER_ACME_MEMBER);
const admin = asUser(USER_ACME_ADMIN);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR' });

async function getOrder(id: string, as = member, ws = WS_ACME) {
  return (await api.http().get(orderPath(ws, id)).set(as).expect(200)).body as Record<
    string,
    unknown
  >;
}
async function eventsOf(id: string, as = member) {
  const { body } = await api
    .http()
    .get(`${orderPath(WS_ACME, id)}/events`)
    .set(as)
    .expect(200);
  return (body as { items: Record<string, unknown>[] }).items;
}

describe('POST /orders (ORD-001, CALC-015, CALC-016, VAL-005)', () => {
  it('creates a DRAFT, answers 201 { id } with Location, and prices it from the catalog', async () => {
    const product = await productFactory.create({ priceMinor: 1250n });

    const res = await api
      .http()
      .post(ordersPath(WS_ACME))
      .set(member)
      .send({
        items: [{ productId: product.id, quantity: 3 }],
        discount: { type: 'PERCENT', valueBps: 1000 },
      })
      .expect(201);

    expect(res.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const id = (res.body as { id: string }).id;
    expect(res.headers.location).toBe(orderPath(WS_ACME, id));

    const order = await getOrder(id);
    expect(order).toMatchObject({
      id,
      status: 'DRAFT',
      version: 0,
      paymentAttempt: 0,
      currency: 'EUR',
      taxRateBps: 2000,
      createdBy: USER_ACME_MEMBER,
      discount: { type: 'PERCENT', valueBps: 1000, value: null },
      totals: { subtotal: eur(3750), discount: eur(375), tax: eur(675), total: eur(4050) },
      items: [
        {
          id: expect.any(String),
          productId: product.id,
          sku: product.sku,
          name: product.name,
          unitPrice: eur(1250),
          quantity: 3,
          lineTotal: eur(3750),
        },
      ],
    });
  });

  it('returns every field, null where absent, dates as ISO-8601 UTC (ORD-024, VAL-004)', async () => {
    const { id } = await orderFactory.create();
    const order = await getOrder(id);

    for (const key of [
      'pspChargeId',
      'failureReason',
      'placedAt',
      'paidAt',
      'fulfilledAt',
      'cancelledAt',
    ]) {
      expect(order).toHaveProperty(key, null);
    }
    expect(order.createdAt).toMatch(ISO_UTC);
    expect(order.updatedAt).toMatch(ISO_UTC);
  });

  it.each([
    {
      name: '2 × 299, no discount, tax 20 % → total 718',
      price: 299n,
      qty: 2,
      discount: { type: 'NONE' },
      expect: { total: eur(718) },
    },
    {
      name: 'PERCENT 5000 of subtotal 3 → discount 2 (1.5 rounds up)',
      price: 3n,
      qty: 1,
      discount: { type: 'PERCENT', valueBps: 5000 },
      expect: { discount: eur(2) },
    },
    {
      name: 'FIXED above the subtotal → discount = subtotal',
      price: 500n,
      qty: 1,
      discount: { type: 'FIXED', valueMinor: 900 },
      expect: { discount: eur(500), total: eur(0) },
    },
  ])('CALC-015 example: $name', async ({ price, qty, discount, expect: totals }) => {
    const product = await productFactory.create({ priceMinor: price });
    const res = await api
      .http()
      .post(ordersPath(WS_ACME))
      .set(member)
      .send({ items: [{ productId: product.id, quantity: qty }], discount })
      .expect(201);

    expect((await getOrder((res.body as { id: string }).id)).totals).toMatchObject(totals);
  });

  it('records ORDER_CREATED (null → DRAFT) by the creator (ORD-019, ORD-020)', async () => {
    const res = await api
      .http()
      .post(ordersPath(WS_ACME))
      .set(member)
      .send({ items: [] })
      .expect(201);

    expect(await eventsOf((res.body as { id: string }).id)).toEqual([
      {
        id: expect.any(String),
        type: 'ORDER_CREATED',
        fromStatus: null,
        toStatus: 'DRAFT',
        actor: USER_ACME_MEMBER,
        payload: {},
        createdAt: expect.stringMatching(ISO_UTC),
      },
    ]);
  });
});

describe('snapshots (CALC-012, CALC-013, CALC-014)', () => {
  it("copies the workspace's currency and tax rate; later workspace changes do not touch the order", async () => {
    const workspace = await workspaceFactory.create({ currency: 'EUR', taxRateBps: 2000 });
    const user = await userFactory.create();
    await membershipFactory.create({ workspaceId: workspace.id, userId: user.id, role: 'MEMBER' });
    const product = await productFactory.create({ workspaceId: workspace.id, priceMinor: 1000n });
    const as = asUser(user.id);

    const res = await api
      .http()
      .post(ordersPath(workspace.id))
      .set(as)
      .send({ items: [{ productId: product.id, quantity: 1 }] })
      .expect(201);
    await testDb().workspace.update({
      where: { id: workspace.id },
      data: { currency: 'USD', taxRateBps: 500 },
    });

    const order = await getOrder((res.body as { id: string }).id, as, workspace.id);
    expect(order).toMatchObject({
      currency: 'EUR',
      taxRateBps: 2000,
      totals: { tax: eur(200), total: eur(1200) },
    });
  });

  it("uses the order workspace's terms: globex orders are USD without tax", async () => {
    const res = await api
      .http()
      .post(ordersPath(WS_GLOBEX))
      .set(asUser(USER_GLOBEX_MEMBER))
      .send({ items: [] })
      .expect(201);

    expect(
      await getOrder((res.body as { id: string }).id, asUser(USER_GLOBEX_MEMBER), WS_GLOBEX),
    ).toMatchObject({
      currency: 'USD',
      taxRateBps: 0,
    });
  });

  it('keeps sku, name and price of an item after the product changes, until the items are set again', async () => {
    const product = await productFactory.create({ priceMinor: 1000n, name: 'Old name' });
    const res = await api
      .http()
      .post(ordersPath(WS_ACME))
      .set(member)
      .send({ items: [{ productId: product.id, quantity: 1 }] })
      .expect(201);
    const id = (res.body as { id: string }).id;

    await api
      .http()
      .patch(productPath(WS_ACME, product.id))
      .set(admin)
      .send({ name: 'New name', priceMinor: 2000 })
      .expect(204);
    expect((await getOrder(id)).items).toMatchObject([{ name: 'Old name', unitPrice: eur(1000) }]);

    // PATCH of the order sets the items again → a new snapshot
    await api
      .http()
      .patch(orderPath(WS_ACME, id))
      .set(member)
      .send({
        version: 0,
        items: [{ productId: product.id, quantity: 1 }],
        discount: { type: 'NONE' },
      })
      .expect(204);
    expect((await getOrder(id)).items).toMatchObject([{ name: 'New name', unitPrice: eur(2000) }]);
  });
});

describe('PATCH /orders/{id} (ORD-008, ORD-010, ORD-019)', () => {
  it('replaces items and discount of a DRAFT, bumps version by 1 and adds no history', async () => {
    const { id } = await orderFactory.create();
    const other = await productFactory.create({ priceMinor: 100n });

    await api
      .http()
      .patch(orderPath(WS_ACME, id))
      .set(member)
      .send({
        version: 0,
        items: [{ productId: other.id, quantity: 5 }],
        discount: { type: 'FIXED', valueMinor: 50 },
      })
      .expect(204);

    expect(await getOrder(id)).toMatchObject({
      version: 1,
      items: [{ productId: other.id, quantity: 5 }],
      discount: { type: 'FIXED', valueBps: null, value: eur(50) },
      totals: { subtotal: eur(500), discount: eur(50) },
    });
    expect((await eventsOf(id)).map((e) => e.type)).toEqual(['ORDER_CREATED']);
  });

  it('refuses to edit an order that is no longer a DRAFT: 422 ORDER_NOT_EDITABLE', async () => {
    const { id } = await orderFactory.create({ status: 'PENDING_PAYMENT' });

    const res = await api
      .http()
      .patch(orderPath(WS_ACME, id))
      .set(member)
      .send({ version: 0, items: [], discount: { type: 'NONE' } })
      .expect(422);
    expect(res.body).toMatchObject({ code: 'ORDER_NOT_EDITABLE' });
  });
});

describe('POST /orders/{id}/place (ORD-011, ORD-021)', () => {
  it('moves a DRAFT to PENDING_PAYMENT: 202 { id, status } with the Location of the order', async () => {
    const { id } = await orderFactory.create();

    const res = await api
      .http()
      .post(`${orderPath(WS_ACME, id)}/place`)
      .set(member)
      .send({ version: 0 })
      .expect(202);

    expect(res.body).toEqual({ id, status: 'PENDING_PAYMENT' });
    expect(res.headers.location).toBe(orderPath(WS_ACME, id));
    const order = await getOrder(id);
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', version: 1, paymentAttempt: 1 });
    expect(order.placedAt).toMatch(ISO_UTC);

    const placed = (await eventsOf(id)).at(-1);
    expect(placed).toMatchObject({
      type: 'ORDER_PLACED',
      fromStatus: 'DRAFT',
      toStatus: 'PENDING_PAYMENT',
      actor: USER_ACME_MEMBER,
      payload: { paymentAttempt: 1 },
    });
  });

  it('places a PAYMENT_FAILED order again as a new attempt and clears the failure reason', async () => {
    const { id } = await orderFactory.create({ status: 'PAYMENT_FAILED' });
    expect((await getOrder(id)).failureReason).toBe('card_declined');

    await api
      .http()
      .post(`${orderPath(WS_ACME, id)}/place`)
      .set(member)
      .send({ version: 0 })
      .expect(202);

    expect(await getOrder(id)).toMatchObject({
      status: 'PENDING_PAYMENT',
      paymentAttempt: 2,
      failureReason: null,
      version: 1,
    });
  });
});

describe('cancel and fulfill (ORD-014, ORD-017, ORD-018, ORD-020, ORD-021)', () => {
  it.each(['DRAFT', 'PAYMENT_FAILED'] as const)(
    'cancels a %s order: 204, CANCELLED, cancelledAt set',
    async (status) => {
      const { id } = await orderFactory.create({ status });

      await api
        .http()
        .post(`${orderPath(WS_ACME, id)}/cancel`)
        .set(member)
        .send({ version: 0 })
        .expect(204);

      const order = await getOrder(id);
      expect(order).toMatchObject({ status: 'CANCELLED', version: 1 });
      expect(order.cancelledAt).toMatch(ISO_UTC);
      expect((await eventsOf(id)).at(-1)).toMatchObject({
        type: 'ORDER_CANCELLED',
        toStatus: 'CANCELLED',
      });
    },
  );

  it('fulfills a PAID order as an admin, and the full history reads oldest first', async () => {
    const { id } = await orderFactory.create({ status: 'PAID' });

    await api
      .http()
      .post(`${orderPath(WS_ACME, id)}/fulfill`)
      .set(admin)
      .send({ version: 0 })
      .expect(204);

    const order = await getOrder(id);
    expect(order).toMatchObject({ status: 'FULFILLED', version: 1 });
    expect(order.fulfilledAt).toMatch(ISO_UTC);
    expect(await eventsOf(id)).toMatchObject([
      {
        type: 'ORDER_CREATED',
        fromStatus: null,
        toStatus: 'DRAFT',
        actor: USER_ACME_MEMBER,
        payload: {},
      },
      {
        type: 'ORDER_PLACED',
        fromStatus: 'DRAFT',
        toStatus: 'PENDING_PAYMENT',
        payload: { paymentAttempt: 1 },
      },
      {
        type: 'PAYMENT_SUCCEEDED',
        toStatus: 'PAID',
        actor: 'system:consumer:orders',
        payload: { paymentAttempt: 1, pspChargeId: `ch_test_${id}` },
      },
      {
        type: 'ORDER_FULFILLED',
        fromStatus: 'PAID',
        toStatus: 'FULFILLED',
        actor: USER_ACME_ADMIN,
        payload: {},
      },
    ]);
  });
});
