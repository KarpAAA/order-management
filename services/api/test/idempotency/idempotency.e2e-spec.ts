// The Idempotency-Key of the HTTP API, through the whole app (IDK-001…009): what a client
// that repeats a write gets back, and what was done in the database and on the broker
// meanwhile. The store and its transaction are in idempotency.int-spec.ts.
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { orderPath, ordersPath, productsPath } from '../helpers/paths';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import {
  PRODUCT_ACME_ACTIVE,
  PRODUCT_GLOBEX_ACTIVE,
  USER_ACME_ADMIN,
  USER_ACME_MEMBER,
  USER_GLOBEX_MEMBER,
  WS_ACME,
  WS_GLOBEX,
} from '../seed/ids';
import { testDb } from '../setup/db';

const HEADER = 'Idempotency-Key';

let api: ApiApp;
let worker: WorkerApp;
let broker: TestBroker;

beforeAll(async () => {
  // first: its queues must be bound before the api publishes anything
  broker = await connectTestBroker();
  api = await createApiApp();
  worker = await createWorkerApp();
});
afterAll(async () => {
  try {
    await worker.close();
  } finally {
    await api.close();
    await broker.close();
  }
});

const member = asUser(USER_ACME_MEMBER);
const admin = asUser(USER_ACME_ADMIN);

const newOrder = (quantity = 1, productId = PRODUCT_ACME_ACTIVE) => ({
  items: [{ productId, quantity }],
});

const createOrder = (key: string, body: object = newOrder(), ws = WS_ACME, as = member) =>
  api.http().post(ordersPath(ws)).set(as).set(HEADER, key).send(body);

const ordersOf = (userId: string) => testDb().order.count({ where: { createdBy: userId } });
const keysOf = (key: string) => testDb().idempotencyKey.findMany({ where: { key } });

describe('POST /orders requires the key (IDK-001)', () => {
  it.each([
    ['no header', undefined],
    ['a key that is not a uuid', 'my-order-1'],
  ])('400 IDEMPOTENCY_KEY_REQUIRED with %s, and nothing is created', async (_case, key) => {
    const before = await ordersOf(USER_ACME_MEMBER);
    const req = api.http().post(ordersPath(WS_ACME)).set(member);

    const res = await (key === undefined ? req.unset(HEADER) : req.set(HEADER, key)).send(
      newOrder(),
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(await ordersOf(USER_ACME_MEMBER)).toBe(before);
  });

  it('checks who is asking before it looks at the key: 401 without a token', async () => {
    await api.http().post(ordersPath(WS_ACME)).unset(HEADER).send(newOrder()).expect(401);
  });
});

describe('the same request again gets the same answer (IDK-002, IDK-003)', () => {
  it('creates one order for one key, however often it is sent', async () => {
    const key = uuidv7();
    const before = await ordersOf(USER_ACME_MEMBER);

    const first = await createOrder(key).expect(201);
    const second = await createOrder(key).expect(201);
    const third = await createOrder(key).expect(201);

    const { id } = first.body as { id: string };
    expect(second.body).toEqual({ id });
    expect(third.body).toEqual({ id });
    // the answer as it was: the header of the first one too
    expect(second.headers.location).toBe(first.headers.location);
    expect(second.headers.location).toBe(orderPath(WS_ACME, id));
    expect(await ordersOf(USER_ACME_MEMBER)).toBe(before + 1);
  });

  it('IDK-002 echoes the key and stores the answer with it', async () => {
    const key = uuidv7();

    const res = await createOrder(key).expect(201);

    expect(res.headers['idempotency-key']).toBe(key);
    expect(await keysOf(key)).toEqual([
      expect.objectContaining({
        userId: USER_ACME_MEMBER,
        scope: `POST ${ordersPath(WS_ACME)}`,
        statusCode: 201,
        response: res.body,
      }),
    ]);
  });

  it('a key of its own is an order of its own', async () => {
    const first = await createOrder(uuidv7()).expect(201);
    const second = await createOrder(uuidv7()).expect(201);

    expect((second.body as { id: string }).id).not.toBe((first.body as { id: string }).id);
  });
});

describe('the key with another request (IDK-004, IDK-005)', () => {
  it('IDK-004 422 IDEMPOTENCY_KEY_REUSED for another body, and no second order', async () => {
    const key = uuidv7();
    await createOrder(key, newOrder(1)).expect(201);
    const before = await ordersOf(USER_ACME_MEMBER);

    const res = await createOrder(key, newOrder(2));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', details: { key } });
    expect(await ordersOf(USER_ACME_MEMBER)).toBe(before);
  });

  it('IDK-004 the same body with its fields in another order is the same request', async () => {
    const key = uuidv7();
    const first = await createOrder(key, {
      items: [{ productId: PRODUCT_ACME_ACTIVE, quantity: 3 }],
      discount: { type: 'PERCENT', valueBps: 500 },
    }).expect(201);

    const second = await createOrder(key, {
      discount: { valueBps: 500, type: 'PERCENT' },
      items: [{ quantity: 3, productId: PRODUCT_ACME_ACTIVE }],
    });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it('IDK-005 the same key of another user in another workspace is a key of its own', async () => {
    const key = uuidv7();
    const first = await createOrder(key).expect(201);

    const second = await createOrder(
      key,
      newOrder(1, PRODUCT_GLOBEX_ACTIVE),
      WS_GLOBEX,
      asUser(USER_GLOBEX_MEMBER),
    ).expect(201);

    expect((second.body as { id: string }).id).not.toBe((first.body as { id: string }).id);
    expect(await keysOf(key)).toHaveLength(2);
  });

  it('IDK-005 the same key of another user in the same workspace does not see the first answer', async () => {
    const key = uuidv7();
    const first = await createOrder(key).expect(201);

    const second = await createOrder(key, newOrder(), WS_ACME, admin).expect(201);

    expect((second.body as { id: string }).id).not.toBe((first.body as { id: string }).id);
  });
});

describe('two requests with one key at once (IDK-006)', () => {
  it('one order is created; whoever came second is told to retry or gets the same answer', async () => {
    const key = uuidv7();
    const before = await ordersOf(USER_ACME_MEMBER);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => createOrder(key).then((res) => res)),
    );

    const created = responses.filter((res) => res.status === 201);
    const busy = responses.filter((res) => res.status === 409);
    expect(created.length + busy.length).toBe(5);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((res) => (res.body as { id: string }).id)).size).toBe(1);
    for (const res of busy) {
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
      expect(res.headers['retry-after']).toBe('1');
    }
    expect(await ordersOf(USER_ACME_MEMBER)).toBe(before + 1);
  });
});

describe('a request that is refused leaves its key free (IDK-007)', () => {
  it('a body that fails validation, sent again corrected with the same key, is handled', async () => {
    const key = uuidv7();
    await createOrder(key, { items: [{ productId: 'not-a-uuid', quantity: 1 }] }).expect(400);
    expect(await keysOf(key)).toEqual([]);

    await createOrder(key, newOrder()).expect(201);
  });

  it('a refusal by business is not remembered either: 404 for a product of another workspace', async () => {
    const key = uuidv7();
    await createOrder(key, newOrder(1, PRODUCT_GLOBEX_ACTIVE)).expect(404);

    expect(await keysOf(key)).toEqual([]);
  });
});

describe('POST /orders/{id}/place is done once per key (IDK-001, IDK-003)', () => {
  const place = (orderId: string, key: string, version = 0) =>
    api
      .http()
      .post(`${orderPath(WS_ACME, orderId)}/place`)
      .set(member)
      .set(HEADER, key)
      .send({ version });

  it('400 without the key, and the order stays a DRAFT', async () => {
    const { id } = await orderFactory.create();

    const res = await api
      .http()
      .post(`${orderPath(WS_ACME, id)}/place`)
      .set(member)
      .unset(HEADER)
      .send({ version: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(await testDb().order.findFirstOrThrow({ where: { id } })).toMatchObject({
      status: 'DRAFT',
    });
  });

  it('IDK-003 the same key again is 202 again: one attempt, one saga, one reservation asked for', async () => {
    const { id } = await orderFactory.create();
    const key = uuidv7();

    const first = await place(id, key).expect(202);
    // without the key this would be 409: the order is at version 1 now
    const second = await place(id, key).expect(202);
    await broker.waitForCommands(id);

    expect(second.body).toEqual(first.body);
    expect(second.body).toEqual({ id, status: 'PENDING_PAYMENT' });
    expect(second.headers.location).toBe(orderPath(WS_ACME, id));
    expect(await testDb().order.findFirstOrThrow({ where: { id } })).toMatchObject({
      paymentAttempt: 1,
    });
    expect(await testDb().orderSaga.count({ where: { orderId: id } })).toBe(1);
    expect(broker.sent('inventory.reserve-stock', id)).toHaveLength(1);
    expect(broker.commands(id)).toHaveLength(1);
  });

  it('IDK-007 a place that is refused (a stale version) is not remembered', async () => {
    const { id } = await orderFactory.create();
    const key = uuidv7();
    await place(id, key, 7).expect(409);

    // the client read the order and sends the right version, with the same key
    await place(id, key, 0).expect(202);
  });

  it('IDK-005 the key of one order does not answer for another', async () => {
    const first = await orderFactory.create();
    const second = await orderFactory.create();
    const key = uuidv7();

    await place(first.id, key).expect(202);
    const res = await place(second.id, key).expect(202);

    expect(res.body).toEqual({ id: second.id, status: 'PENDING_PAYMENT' });
  });
});

describe('a route that needs no key ignores one (IDK-009)', () => {
  it('creates two products with the same key: their unique SKU is what refuses a repetition', async () => {
    const key = uuidv7();
    const product = (sku: string) =>
      api
        .http()
        .post(productsPath(WS_ACME))
        .set(admin)
        .set(HEADER, key)
        .send({ sku, name: 'Idempotency probe', priceMinor: 100 });

    const sku = `IDK-${key.slice(-12)}`;
    await product(sku).expect(201);
    // the same request again: refused by the SKU, not replayed
    await product(sku).expect(409);
    await product(`${sku}-2`).expect(201);

    expect(await keysOf(key)).toEqual([]);
  });

  it('answers a route without the header as before', async () => {
    const { id } = await orderFactory.create();

    await api
      .http()
      .post(`${orderPath(WS_ACME, id)}/cancel`)
      .set(member)
      .unset(HEADER)
      .send({ version: 0 })
      .expect(204);
  });
});
