// Cancelling an order while its saga runs (SAGA-020…023), to the boundary of the api: what the
// client is told (204 or 202), what the api asks of inventory and payments, and how the order
// ends when they answer. The test is the other side of the broker and plays both services.
// A cancellation after a timeout (SAGA-022) is in saga-timeouts.e2e-spec.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import {
  connectTestBroker,
  paymentCancelled,
  paymentFailed,
  paymentSucceeded,
  stockReleased,
  stockReserved,
  type TestBroker,
} from '../helpers/broker';
import { orderPath } from '../helpers/paths';
import { waitFor, waitForStatus } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { USER_ACME_MEMBER, USER_ACME_VIEWER, WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

let api: ApiApp;
let worker: WorkerApp;
let broker: TestBroker;

beforeAll(async () => {
  // first: its queues must be bound before the api publishes anything
  broker = await connectTestBroker({ inventory: 'silent' });
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
const viewer = asUser(USER_ACME_VIEWER);

const attempt = (orderId: string, paymentAttempt = 1) => ({
  workspaceId: WS_ACME,
  orderId,
  paymentAttempt,
});

interface OrderBody {
  status: string;
  version: number;
  failureReason: string | null;
  cancelledAt: string | null;
}

async function read(orderId: string): Promise<OrderBody> {
  const { body } = await api.http().get(orderPath(WS_ACME, orderId)).set(member).expect(200);
  return body as OrderBody;
}

/** Cancels with the version a client has just read, as a client would. */
async function cancel(orderId: string, as = member) {
  const { version } = await read(orderId);
  return api
    .http()
    .post(`${orderPath(WS_ACME, orderId)}/cancel`)
    .set(as)
    .send({ version });
}

async function historyOf(orderId: string) {
  const { body } = await api
    .http()
    .get(`${orderPath(WS_ACME, orderId)}/events`)
    .set(member)
    .expect(200);
  return (
    body as { items: { type: string; actor: string; fromStatus: string; toStatus: string }[] }
  ).items;
}

const sagaOf = (orderId: string) =>
  testDb().orderSaga.findFirstOrThrow({ where: { orderId, attempt: 1 } });
const sagaIn = (orderId: string, step: string) =>
  waitFor(
    () => sagaOf(orderId),
    (saga) => saga.step === step,
    { what: `the saga of order ${orderId} to be ${step}` },
  );
const settled = (orderId: string, statuses: readonly string[]) =>
  waitForStatus(api, orderPath(WS_ACME, orderId), member, statuses);

/** A placed order whose reservation was asked for and not answered yet. */
async function reserving(): Promise<string> {
  const { id } = await orderFactory.create();
  await api
    .http()
    .post(`${orderPath(WS_ACME, id)}/place`)
    .set(member)
    .send({ version: 0 })
    .expect(202);
  await broker.waitForSent('inventory.reserve-stock', id);
  return id;
}

/** A placed order whose stock is reserved: its saga waits for the answer of payments. */
async function charging(): Promise<string> {
  const id = await reserving();
  await broker.publish(stockReserved(attempt(id)));
  await broker.waitForCommands(id);
  return id;
}

/**
 * Proof that every answer published before this call has been handled: the worker takes one
 * message at a time (RABBITMQ_PREFETCH=1), so an order that is placed, reserved and paid
 * after them is behind them in both queues.
 */
async function drained(): Promise<void> {
  const id = await charging();
  await broker.publish(paymentSucceeded(attempt(id), 'ch_marker'));
  await settled(id, ['PAID']);
}

describe('cancel while the stock is being reserved (SAGA-020)', () => {
  let orderId: string;

  it('204: the order is CANCELLED at once, without waiting for inventory', async () => {
    orderId = await reserving();

    const res = await cancel(orderId);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(await read(orderId)).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: expect.any(String),
      failureReason: null,
      version: 2,
    });
  });

  it('publishes orders.order-cancelled and asks inventory to release in the dark', async () => {
    const [release] = await broker.waitForSent('inventory.release-stock', orderId);
    const events = await broker.waitForOrderEvents(orderId, 2);

    expect(release).toMatchObject({ workspaceId: WS_ACME, payload: { orderId, attempt: 1 } });
    expect(events.map((event) => event.name)).toEqual([
      'orders.order-placed',
      'orders.order-cancelled',
    ]);
    expect(await sagaOf(orderId)).toMatchObject({
      step: 'RELEASING',
      cancelRequestedAt: expect.any(Date),
    });
  });

  it('a "reserved" that arrives now asks for no charge and does not revive the order', async () => {
    await broker.publish(stockReserved(attempt(orderId)));
    await drained();

    expect(broker.commands(orderId)).toEqual([]);
    expect(await read(orderId)).toMatchObject({ status: 'CANCELLED', version: 2 });
  });

  it('the saga ends when inventory has released, and the history tells it', async () => {
    await broker.publish(stockReleased(attempt(orderId)));
    await sagaIn(orderId, 'ABORTED');

    expect(await historyOf(orderId)).toMatchObject([
      { type: 'ORDER_CREATED' },
      { type: 'ORDER_PLACED' },
      {
        type: 'ORDER_CANCELLED',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CANCELLED',
        actor: USER_ACME_MEMBER,
      },
      { type: 'STOCK_RELEASED', fromStatus: 'CANCELLED', toStatus: 'CANCELLED' },
    ]);
  });
});

describe('cancel while the charge is under way (SAGA-021)', () => {
  it('202 with the order still PENDING_PAYMENT, and payments is asked not to charge', async () => {
    const orderId = await charging();

    const res = await cancel(orderId);
    const [cancellation] = await broker.waitForSent('payments.cancel-payment', orderId);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: orderId, status: 'PENDING_PAYMENT' });
    // where to poll: the order the action ran on
    expect(res.headers.location).toBe(orderPath(WS_ACME, orderId));
    expect(cancellation).toMatchObject({
      name: 'payments.cancel-payment',
      workspaceId: WS_ACME,
      payload: { orderId, paymentAttempt: 1 },
    });
    expect(await read(orderId)).toMatchObject({ status: 'PENDING_PAYMENT', cancelledAt: null });
    expect(await sagaOf(orderId)).toMatchObject({
      step: 'CANCELLING_PAYMENT',
      cancelRequestedAt: expect.any(Date),
    });
    // nothing is decided yet: the stock stays held until payments has answered
    expect(broker.sent('inventory.release-stock', orderId)).toEqual([]);
    expect((await historyOf(orderId)).at(-1)).toMatchObject({
      type: 'CANCELLATION_REQUESTED',
      fromStatus: 'PENDING_PAYMENT',
      toStatus: 'PENDING_PAYMENT',
      actor: USER_ACME_MEMBER,
    });
  });

  it.each([
    ['payments cancelled the attempt', (id: string) => paymentCancelled(attempt(id))],
    [
      'the charge was declined meanwhile',
      (id: string) => paymentFailed(attempt(id), 'card_declined'),
    ],
  ])('ends CANCELLED when %s, and releases the stock', async (_case, answer) => {
    const orderId = await charging();
    expect((await cancel(orderId)).status).toBe(202);
    await broker.waitForSent('payments.cancel-payment', orderId);

    await broker.publish(answer(orderId));
    const order = await settled(orderId, ['CANCELLED', 'PAYMENT_FAILED', 'PAID']);
    await broker.waitForSent('inventory.release-stock', orderId);
    await broker.publish(stockReleased(attempt(orderId)));
    await sagaIn(orderId, 'ABORTED');

    expect(order).toMatchObject({ status: 'CANCELLED', failureReason: null });
    expect((await broker.waitForOrderEvents(orderId, 2)).map((event) => event.name)).toEqual([
      'orders.order-placed',
      'orders.order-cancelled',
    ]);
    expect((await historyOf(orderId)).slice(3)).toMatchObject([
      { type: 'CANCELLATION_REQUESTED', actor: USER_ACME_MEMBER },
      {
        type: 'ORDER_CANCELLED',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CANCELLED',
        actor: 'system:consumer:orders',
      },
      { type: 'STOCK_RELEASED' },
    ]);
  });

  it('ends PAID when the charge was made first: the cancellation came too late', async () => {
    const orderId = await charging();
    expect((await cancel(orderId)).status).toBe(202);
    await broker.waitForSent('payments.cancel-payment', orderId);

    await broker.publish(paymentSucceeded(attempt(orderId), 'ch_first'));
    const order = await settled(orderId, ['CANCELLED', 'PAYMENT_FAILED', 'PAID']);
    await drained();

    expect(order).toMatchObject({ status: 'PAID', pspChargeId: 'ch_first', cancelledAt: null });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'COMPLETED' });
    expect(broker.sent('inventory.release-stock', orderId)).toEqual([]);
    expect(broker.orderEvents(orderId).map((event) => event.name)).toEqual([
      'orders.order-placed',
      'orders.order-paid',
    ]);
  });

  it('SAGA-022 a second request is 202 again and writes nothing', async () => {
    const orderId = await charging();
    expect((await cancel(orderId)).status).toBe(202);
    const before = await read(orderId);

    const res = await cancel(orderId);
    await drained();

    expect(res.status).toBe(202);
    expect(await read(orderId)).toEqual(before);
    expect(broker.sent('payments.cancel-payment', orderId)).toHaveLength(1);
  });

  it('cancels an order whose charge was asked for before the saga existed (seeded, migrated)', async () => {
    // as the migration and the seed leave such an order: a saga in CHARGING, no timeout
    const { id } = await orderFactory.create({ status: 'PENDING_PAYMENT' });

    const res = await api
      .http()
      .post(`${orderPath(WS_ACME, id)}/cancel`)
      .set(member)
      .send({ version: 0 });
    await broker.waitForSent('payments.cancel-payment', id);
    await broker.publish(paymentCancelled(attempt(id)));

    expect(res.status).toBe(202);
    expect(await settled(id, ['CANCELLED'])).toMatchObject({ status: 'CANCELLED' });
  });
});

describe('a cancellation that is refused writes nothing (SAGA-023)', () => {
  it('409 for a version the order no longer has', async () => {
    const orderId = await charging();
    const before = await read(orderId);

    await api
      .http()
      .post(`${orderPath(WS_ACME, orderId)}/cancel`)
      .set(member)
      .send({ version: before.version - 1 })
      .expect(409);
    await drained();

    expect(await read(orderId)).toEqual(before);
    expect(await sagaOf(orderId)).toMatchObject({ step: 'CHARGING', cancelRequestedAt: null });
    expect(broker.sent('payments.cancel-payment', orderId)).toEqual([]);
  });

  it('403 for a VIEWER, while the stock is being reserved as well', async () => {
    const orderId = await reserving();
    const before = await read(orderId);

    expect((await cancel(orderId, viewer)).status).toBe(403);
    await drained();

    expect(await read(orderId)).toEqual(before);
    expect(await sagaOf(orderId)).toMatchObject({ step: 'RESERVING', cancelRequestedAt: null });
    expect(broker.sent('inventory.release-stock', orderId)).toEqual([]);
  });

  it('ORD-016 422 for an order that is paid', async () => {
    const orderId = await charging();
    await broker.publish(paymentSucceeded(attempt(orderId), 'ch_paid'));
    await settled(orderId, ['PAID']);

    const res = await cancel(orderId);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'ORDER_INVALID_TRANSITION' });
  });
});
