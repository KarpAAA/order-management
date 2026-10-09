// Everything the order API refuses: 400 (validation), 404 (unknown product), 409 (stale
// version), 413 (body too large), 422 (state). After a refused write the database must be
// unchanged (ORD-022) — HTTP cannot show that, so those tests look into testDb().
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderFactory, productFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { orderPath, ordersPath } from '../helpers/paths';
import {
  PRODUCT_ACME_ACTIVE,
  PRODUCT_ACME_ARCHIVED,
  PRODUCT_GLOBEX_ACTIVE,
  USER_ACME_ADMIN,
  USER_ACME_MEMBER,
  WS_ACME,
} from '../seed/ids';
import { testDb } from '../setup/db';

let api: ApiApp;
beforeAll(async () => {
  api = await createApiApp();
});
afterAll(() => api.close());

const member = asUser(USER_ACME_MEMBER);
const admin = asUser(USER_ACME_ADMIN);
const item = (productId = PRODUCT_ACME_ACTIVE, quantity = 1) => ({ productId, quantity });

const create = (body: unknown) =>
  api
    .http()
    .post(ordersPath(WS_ACME))
    .set(member)
    .send(body as object);
const action = (id: string, name: string, body: unknown, as = member) =>
  api
    .http()
    .post(`${orderPath(WS_ACME, id)}/${name}`)
    .set(as)
    .send(body as object);

/** Status, version and history of an order as stored. */
async function snapshot(id: string) {
  const row = await testDb().order.findFirstOrThrow({ where: { id } });
  const events = await testDb().orderEvent.count({ where: { orderId: id } });
  return { status: row.status, version: row.version, paymentAttempt: row.paymentAttempt, events };
}

const fieldsOf = (body: unknown) =>
  (body as { details: { fields: { path: string; code: string }[] } }).details.fields;

describe('validation → 400 VALIDATION_FAILED (ORD-002, ORD-003, ORD-007, VAL-001)', () => {
  it('accepts 50 items and rejects 51', async () => {
    const products = await productFactory.createList(51);
    const items = products.map((p) => item(p.id));

    await create({ items: items.slice(0, 50) }).expect(201);
    const res = await create({ items }).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fieldsOf(res.body)).toContainEqual(expect.objectContaining({ path: 'items' }));
  });

  it.each([0, 1001, 1.5])('rejects quantity %s with the path of the field', async (quantity) => {
    const res = await create({ items: [item(PRODUCT_ACME_ACTIVE, quantity)] }).expect(400);
    expect(fieldsOf(res.body)).toContainEqual(
      expect.objectContaining({ path: 'items.0.quantity' }),
    );
  });

  // shape errors are caught by the ValidationPipe, wrong combinations by the domain (discountOf)
  it.each([
    ['NONE with a value', { type: 'NONE', valueBps: 10 }, 'INVALID_ORDER'],
    ['PERCENT without valueBps', { type: 'PERCENT' }, 'VALIDATION_FAILED'],
    ['PERCENT above 100 %', { type: 'PERCENT', valueBps: 10_001 }, 'VALIDATION_FAILED'],
    ['PERCENT with valueMinor', { type: 'PERCENT', valueBps: 10, valueMinor: 5 }, 'INVALID_ORDER'],
    ['FIXED without valueMinor', { type: 'FIXED' }, 'VALIDATION_FAILED'],
    ['FIXED negative', { type: 'FIXED', valueMinor: -1 }, 'VALIDATION_FAILED'],
    ['FIXED with valueBps', { type: 'FIXED', valueMinor: 5, valueBps: 10 }, 'INVALID_ORDER'],
    ['FIXED above 2^53 − 1', { type: 'FIXED', valueMinor: 2 ** 53 }, 'VALIDATION_FAILED'],
    ['an unknown type', { type: 'BOGO' }, 'VALIDATION_FAILED'],
  ])('rejects a discount: %s → 400 %s', async (_name, discount, code) => {
    const res = await create({ items: [], discount }).expect(400);
    expect(res.body).toMatchObject({ code });
  });

  // found by Schemathesis: the discount is optional, but not nullable
  it('rejects a null discount', async () => {
    const res = await create({ items: [], discount: null }).expect(400);
    expect(fieldsOf(res.body)).toContainEqual(expect.objectContaining({ path: 'discount' }));
  });

  it('rejects an unknown body field, naming it', async () => {
    const res = await create({ items: [], note: 'hi' }).expect(400);
    expect(fieldsOf(res.body)).toContainEqual(
      expect.objectContaining({ path: 'note', code: 'whitelistValidation' }),
    );
  });

  it('rejects an unknown query parameter', async () => {
    const res = await api
      .http()
      .get(ordersPath(WS_ACME))
      .query({ sort: 'asc' })
      .set(member)
      .expect(400);
    expect(fieldsOf(res.body)).toContainEqual(expect.objectContaining({ path: 'sort' }));
  });

  it('rejects a non-UUID order id (ORD-025)', async () => {
    await api.http().get(orderPath(WS_ACME, 'not-a-uuid')).set(member).expect(400);
  });

  it.each([
    [
      'PATCH',
      (id: string) =>
        api
          .http()
          .patch(orderPath(WS_ACME, id))
          .set(member)
          .send({ items: [], discount: { type: 'NONE' } }),
    ],
    ['place', (id: string) => action(id, 'place', {})],
    ['cancel', (id: string) => action(id, 'cancel', {})],
    ['fulfill', (id: string) => action(id, 'fulfill', {}, admin)],
  ])('requires version on %s (ORD-009)', async (_name, send) => {
    const { id } = await orderFactory.create();
    const res = await send(id).expect(400);
    expect(fieldsOf(res.body)).toContainEqual(expect.objectContaining({ path: 'version' }));
  });

  // found by Schemathesis: a missing discount used to pass validation and crash with 500
  it.each([
    ['discount', { version: 0, items: [] }],
    ['items', { version: 0, discount: { type: 'NONE' } }],
  ])('PATCH requires %s (ORD-008)', async (field, body) => {
    const { id } = await orderFactory.create();
    const res = await api.http().patch(orderPath(WS_ACME, id)).set(member).send(body).expect(400);
    expect(fieldsOf(res.body)).toContainEqual(expect.objectContaining({ path: field }));
  });
});

describe('malformed and oversized bodies (VAL-002)', () => {
  it('answers 400 to malformed JSON', async () => {
    await api
      .http()
      .post(ordersPath(WS_ACME))
      .set(member)
      .set('Content-Type', 'application/json')
      .send('{"items": [')
      .expect(400);
  });

  it('answers 413 to a body over 10 kB', async () => {
    await create({ items: [], padding: 'x'.repeat(11 * 1024) }).expect(413);
  });
});

describe('items the catalog refuses (ORD-004, ORD-005, ORD-006)', () => {
  it('400 INVALID_ORDER for the same product twice', async () => {
    const res = await create({ items: [item(), item()] }).expect(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ORDER' });
  });

  it.each([
    ['an unknown product', '01990000-0000-7000-8000-ffffffffffff'],
    ["another workspace's product", PRODUCT_GLOBEX_ACTIVE],
  ])('404 PRODUCT_NOT_FOUND for %s', async (_name, productId) => {
    const res = await create({ items: [item(productId)] }).expect(404);
    expect(res.body).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
  });

  it('422 PRODUCT_NOT_ACTIVE for an archived product', async () => {
    const res = await create({ items: [item(PRODUCT_ACME_ARCHIVED)] }).expect(422);
    expect(res.body).toMatchObject({ code: 'PRODUCT_NOT_ACTIVE' });
  });
});

describe('stale version → 409 STALE_VERSION, nothing written (ORD-009, ORD-022)', () => {
  it.each([
    [
      'PATCH',
      (id: string) =>
        api
          .http()
          .patch(orderPath(WS_ACME, id))
          .set(member)
          .send({ version: 3, items: [], discount: { type: 'NONE' } }),
      'DRAFT',
    ],
    ['place', (id: string) => action(id, 'place', { version: 3 }), 'DRAFT'],
    ['cancel', (id: string) => action(id, 'cancel', { version: 3 }), 'DRAFT'],
    ['fulfill', (id: string) => action(id, 'fulfill', { version: 3 }, admin), 'PAID'],
  ] as const)('%s with a version the order does not have', async (_name, send, status) => {
    const { id } = await orderFactory.create({ status });
    const before = await snapshot(id);

    const res = await send(id).expect(409);

    expect(res.body).toMatchObject({ code: 'STALE_VERSION' });
    expect(await snapshot(id)).toEqual(before);
  });
});

describe('transitions the state machine refuses → 422, nothing written (ORD-012…017, ORD-022)', () => {
  it('422 ORDER_HAS_NO_ITEMS when placing an empty order', async () => {
    const { id } = await orderFactory.create({ lines: [] });
    const before = await snapshot(id);

    const res = await action(id, 'place', { version: 0 }).expect(422);

    expect(res.body).toMatchObject({ code: 'ORDER_HAS_NO_ITEMS' });
    expect(await snapshot(id)).toEqual(before);
  });

  it.each([
    ['place', 'PENDING_PAYMENT', member],
    ['place', 'PAID', member],
    ['place', 'FULFILLED', member],
    ['place', 'CANCELLED', member],
    // cancel from PENDING_PAYMENT is a request to the saga (ORD-015): saga-cancel.e2e-spec.ts
    ['cancel', 'PAID', member],
    ['cancel', 'FULFILLED', member],
    ['cancel', 'CANCELLED', member],
    ['fulfill', 'DRAFT', admin],
    ['fulfill', 'PENDING_PAYMENT', admin],
    ['fulfill', 'PAYMENT_FAILED', admin],
    ['fulfill', 'FULFILLED', admin],
    ['fulfill', 'CANCELLED', admin],
  ] as const)('%s from %s → 422 ORDER_INVALID_TRANSITION', async (name, status, as) => {
    const { id } = await orderFactory.create({ status });
    const before = await snapshot(id);

    const res = await action(id, name, { version: 0 }, as).expect(422);

    expect(res.body).toMatchObject({ code: 'ORDER_INVALID_TRANSITION' });
    expect(await snapshot(id)).toEqual(before);
  });
});
