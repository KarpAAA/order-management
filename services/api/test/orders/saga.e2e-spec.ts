// The order saga, to the boundary of the api (SAGA-001…016): HTTP place → `inventory.reserve-stock`
// → `payments.charge-payment` → PAID, and what happens when one of the two says no. Neither
// service is here: the test is the other side of the broker (helpers/broker.ts, with an
// inventory that answers only what the test publishes) and plays both. Timeouts are in
// saga-timeouts.e2e-spec.ts, cancellation in saga-cancel.e2e-spec.ts.
// Every assertion is on an outcome: a command on the broker, the order as a client reads it,
// its history, the row of the saga.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import {
  connectTestBroker,
  paymentFailed,
  paymentSucceeded,
  stockReleased,
  stockReservationFailed,
  stockReserved,
  type TestBroker,
} from '../helpers/broker';
import { orderPath } from '../helpers/paths';
import { waitFor, waitForStatus } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { PRODUCT_ACME_ACTIVE, USER_ACME_MEMBER, WS_ACME, WS_GLOBEX } from '../seed/ids';
import { testDb } from '../setup/db';

// the queues the worker declares for itself: names on the wire, so the test spells them out
const INVENTORY_QUEUE = 'api.inventory-events';
const INVENTORY_WAIT_QUEUE = 'api.inventory-events.wait.200';
const INVENTORY_DEAD_LETTER_QUEUE = 'api.inventory-events.dlq';
const PAYMENT_WAIT_QUEUE = 'api.payment-events.wait.200';

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

const attempt = (orderId: string, paymentAttempt = 1, workspaceId = WS_ACME) => ({
  workspaceId,
  orderId,
  paymentAttempt,
});

async function place(orderId: string, version = 0): Promise<void> {
  await api
    .http()
    .post(`${orderPath(WS_ACME, orderId)}/place`)
    .set(member)
    .send({ version })
    .expect(202);
}

async function read(orderId: string): Promise<Record<string, unknown>> {
  const { body } = await api.http().get(orderPath(WS_ACME, orderId)).set(member).expect(200);
  return body as Record<string, unknown>;
}

interface HistoryEntry {
  type: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  payload: Record<string, unknown>;
}

/** The history of the order as a client reads it, oldest first. */
async function history(orderId: string): Promise<HistoryEntry[]> {
  const { body } = await api
    .http()
    .get(`${orderPath(WS_ACME, orderId)}/events`)
    .set(member)
    .expect(200);
  return (body as { items: HistoryEntry[] }).items;
}

const sagaOf = (orderId: string, paymentAttempt = 1) =>
  testDb().orderSaga.findFirstOrThrow({ where: { orderId, attempt: paymentAttempt } });

const sagaIn = (orderId: string, step: string, paymentAttempt = 1) =>
  waitFor(
    () => sagaOf(orderId, paymentAttempt),
    (saga) => saga.step === step,
    { what: `the saga of order ${orderId} to be ${step}` },
  );

const settled = (orderId: string, statuses: readonly string[]) =>
  waitForStatus(api, orderPath(WS_ACME, orderId), member, statuses);

const noneWaiting = async () => {
  for (const queue of [INVENTORY_WAIT_QUEUE, PAYMENT_WAIT_QUEUE]) {
    await waitFor(
      () => broker.depth(queue),
      (depth) => depth === 0,
      { what: `${queue} to be empty` },
    );
  }
};

/**
 * Proof that every answer published before this call has been handled: the worker takes one
 * message at a time (RABBITMQ_PREFETCH=1), so an order that is placed, reserved and paid
 * after them is behind them in both queues.
 */
async function drained(): Promise<void> {
  await noneWaiting();
  const { id } = await orderFactory.create();
  await place(id);
  await broker.waitForSent('inventory.reserve-stock', id);
  await broker.publish(stockReserved(attempt(id)));
  await broker.waitForCommands(id);
  await broker.publish(paymentSucceeded(attempt(id), 'ch_marker'));
  await settled(id, ['PAID']);
  await noneWaiting();
}

/** A placed order whose stock is reserved: its saga waits for the answer of payments. */
async function charging(): Promise<string> {
  const { id } = await orderFactory.create();
  await place(id);
  await broker.waitForSent('inventory.reserve-stock', id);
  await broker.publish(stockReserved(attempt(id)));
  await broker.waitForCommands(id);
  return id;
}

describe('success: place → reserve stock → charge → PAID (SAGA-001, 002, 004)', () => {
  let orderId: string;

  it('SAGA-001 place asks inventory for the lines of the order, and for no charge yet', async () => {
    orderId = (
      await orderFactory.create({ lines: [{ productId: PRODUCT_ACME_ACTIVE, quantity: 3 }] })
    ).id;

    await place(orderId);
    const [reservation] = await broker.waitForSent('inventory.reserve-stock', orderId);

    expect(reservation).toMatchObject({
      name: 'inventory.reserve-stock',
      version: 1,
      workspaceId: WS_ACME,
      payload: {
        orderId,
        attempt: 1,
        lines: [{ productId: PRODUCT_ACME_ACTIVE, quantity: 3 }],
      },
    });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'RESERVING', version: 0 });
    expect(await read(orderId)).toMatchObject({ status: 'PENDING_PAYMENT', paymentAttempt: 1 });
    await drained();
    expect(broker.commands(orderId)).toEqual([]);
  });

  it('SAGA-002 when the stock is held it asks for the charge, which expires with the step', async () => {
    const [reservation] = broker.sent('inventory.reserve-stock', orderId);
    const answer = {
      ...stockReserved(attempt(orderId)),
      // inventory answers in the chain of the command
      correlationId: reservation?.correlationId ?? '',
    };

    await broker.publish(answer);
    const [charge] = await broker.waitForCommands(orderId);
    const saga = await sagaIn(orderId, 'CHARGING');

    expect(charge).toMatchObject({
      name: 'payments.charge-payment',
      workspaceId: WS_ACME,
      // SAGA-016: the chain of the request that placed the order
      correlationId: reservation?.correlationId,
      payload: { orderId, paymentAttempt: 1, idempotencyKey: `${orderId}:1` },
    });
    expect(charge?.payload.expiresAt).toBe(saga.deadlineAt?.toISOString());
    // .env.test: ORDER_SAGA_CHARGE_TIMEOUT_MS
    expect(saga.deadlineAt?.getTime()).toBeGreaterThan(Date.now() + 800_000);
    expect(await read(orderId)).toMatchObject({ status: 'PENDING_PAYMENT', version: 2 });
  });

  it('SAGA-004 when the charge succeeds the order is PAID and the saga has ended', async () => {
    await broker.publish(paymentSucceeded(attempt(orderId), 'ch_saga'));

    expect(await settled(orderId, ['PAID'])).toMatchObject({
      pspChargeId: 'ch_saga',
      failureReason: null,
      version: 3,
    });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'COMPLETED', deadlineAt: null });
  });

  it('ORD-018 ORD-021 the history tells the steps, with who took them', async () => {
    expect(await history(orderId)).toMatchObject([
      { type: 'ORDER_CREATED', fromStatus: null, toStatus: 'DRAFT' },
      {
        type: 'ORDER_PLACED',
        fromStatus: 'DRAFT',
        toStatus: 'PENDING_PAYMENT',
        actor: USER_ACME_MEMBER,
      },
      {
        type: 'STOCK_RESERVED',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'PENDING_PAYMENT',
        actor: 'system:consumer:orders',
        payload: { paymentAttempt: 1 },
      },
      { type: 'PAYMENT_SUCCEEDED', fromStatus: 'PENDING_PAYMENT', toStatus: 'PAID' },
    ]);
  });

  it('SAGA-004 compensates nothing: no release is asked for', async () => {
    await drained();

    expect(broker.sent('inventory.release-stock', orderId)).toEqual([]);
    expect(broker.sent('payments.cancel-payment', orderId)).toEqual([]);
    expect(broker.sent('inventory.reserve-stock', orderId)).toHaveLength(1);
    expect(broker.commands(orderId)).toHaveLength(1);
  });
});

describe('declined: the stock goes back (SAGA-005, SAGA-006)', () => {
  let orderId: string;

  it('SAGA-005 a failed charge fails the order at once and asks inventory to release', async () => {
    orderId = await charging();

    await broker.publish(paymentFailed(attempt(orderId), 'card_declined'));
    const order = await settled(orderId, ['PAYMENT_FAILED']);
    const [release] = await broker.waitForSent('inventory.release-stock', orderId);

    expect(order).toMatchObject({ failureReason: 'card_declined', version: 3 });
    expect(release).toMatchObject({
      name: 'inventory.release-stock',
      workspaceId: WS_ACME,
      payload: { orderId, attempt: 1 },
    });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'RELEASING' });
  });

  it('SAGA-006 when inventory has released, the saga ends and the history says so', async () => {
    await broker.publish(stockReleased(attempt(orderId)));
    await sagaIn(orderId, 'ABORTED');

    expect(await read(orderId)).toMatchObject({
      status: 'PAYMENT_FAILED',
      failureReason: 'card_declined',
      version: 4,
    });
    expect((await history(orderId)).slice(2)).toMatchObject([
      { type: 'STOCK_RESERVED' },
      { type: 'PAYMENT_FAILED', fromStatus: 'PENDING_PAYMENT', toStatus: 'PAYMENT_FAILED' },
      {
        type: 'STOCK_RELEASED',
        fromStatus: 'PAYMENT_FAILED',
        toStatus: 'PAYMENT_FAILED',
        actor: 'system:consumer:orders',
        payload: { paymentAttempt: 1 },
      },
    ]);
    expect(await sagaOf(orderId)).toMatchObject({ deadlineAt: null });
  });

  it('PAY-011 placed again, the order starts a saga of its own and reserves again', async () => {
    await place(orderId, 4);
    const reservations = await broker.waitForSent('inventory.reserve-stock', orderId, 2);

    expect(reservations.map((r) => r.payload.attempt)).toEqual([1, 2]);
    expect(await sagaOf(orderId, 2)).toMatchObject({ step: 'RESERVING' });
    expect(await sagaOf(orderId, 1)).toMatchObject({ step: 'ABORTED' });
  });

  it('SAGA-011 a release confirmed again for the first attempt does not touch the second', async () => {
    const before = await read(orderId);

    await broker.publish(stockReleased(attempt(orderId, 1)));
    await drained();

    expect(await read(orderId)).toEqual(before);
    expect(await sagaOf(orderId, 2)).toMatchObject({ step: 'RESERVING' });
  });
});

describe('out of stock: the order is a DRAFT again (SAGA-003)', () => {
  const shortages = [{ productId: PRODUCT_ACME_ACTIVE, requested: 5, available: 2 }];
  let orderId: string;

  it('gives the order back with the reason, and asks for nothing else', async () => {
    orderId = (
      await orderFactory.create({ lines: [{ productId: PRODUCT_ACME_ACTIVE, quantity: 5 }] })
    ).id;
    await place(orderId);
    await broker.waitForSent('inventory.reserve-stock', orderId);

    await broker.publish(stockReservationFailed(attempt(orderId), shortages));
    const order = await settled(orderId, ['DRAFT']);
    await drained();

    expect(order).toMatchObject({
      failureReason: 'out_of_stock',
      placedAt: null,
      paymentAttempt: 1,
      version: 2,
    });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'ABORTED', deadlineAt: null });
    // nothing was done, so nothing is compensated
    expect(broker.commands(orderId)).toEqual([]);
    expect(broker.sent('inventory.release-stock', orderId)).toEqual([]);
  });

  it('ORD-021 the history names the products that fell short', async () => {
    expect((await history(orderId)).at(-1)).toMatchObject({
      type: 'STOCK_RESERVATION_FAILED',
      fromStatus: 'PENDING_PAYMENT',
      toStatus: 'DRAFT',
      actor: 'system:consumer:orders',
      payload: { paymentAttempt: 1, reason: 'out_of_stock', shortages },
    });
  });

  it('the order can be changed and placed again, as the next attempt', async () => {
    await api
      .http()
      .patch(orderPath(WS_ACME, orderId))
      .set(member)
      .send({
        version: 2,
        items: [{ productId: PRODUCT_ACME_ACTIVE, quantity: 2 }],
        discount: { type: 'NONE' },
      })
      .expect(204);
    await place(orderId, 3);
    const reservations = await broker.waitForSent('inventory.reserve-stock', orderId, 2);

    expect(reservations[1]).toMatchObject({
      payload: { attempt: 2, lines: [{ productId: PRODUCT_ACME_ACTIVE, quantity: 2 }] },
    });
    expect(await read(orderId)).toMatchObject({
      status: 'PENDING_PAYMENT',
      paymentAttempt: 2,
      failureReason: null,
    });
  });
});

describe('an answer the saga is not waiting for changes nothing (SAGA-011)', () => {
  it('another "reserved" for the attempt asks for no second charge', async () => {
    const orderId = await charging();
    const before = await read(orderId);

    // a new message id: the inbox does not know it, the saga does
    await broker.publish(stockReserved(attempt(orderId)));
    await drained();

    expect(broker.commands(orderId)).toHaveLength(1);
    expect(await read(orderId)).toEqual(before);
  });

  it('IBX-001 the same "reserved" five times is handled once', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    await broker.waitForSent('inventory.reserve-stock', id);
    const answer = stockReserved(attempt(id));

    for (let delivery = 0; delivery < 5; delivery += 1) await broker.publish(answer);
    await broker.waitForCommands(id);
    await drained();

    expect(broker.commands(id)).toHaveLength(1);
    expect(
      await testDb().inboxMessage.findMany({ where: { messageId: answer.messageId } }),
    ).toEqual([expect.objectContaining({ consumer: INVENTORY_QUEUE })]);
    expect((await history(id)).filter((entry) => entry.type === 'STOCK_RESERVED')).toHaveLength(1);
  });

  it('a payment outcome before the stock is reserved is not taken: nothing was asked of payments', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    await broker.waitForSent('inventory.reserve-stock', id);
    const before = await read(id);

    await broker.publish(paymentSucceeded(attempt(id), 'ch_forged'));
    await drained();

    expect(await read(id)).toEqual(before);
    expect(await sagaOf(id)).toMatchObject({ step: 'RESERVING' });
  });

  it('"out of stock" after the stock was reserved does not take the order back', async () => {
    const orderId = await charging();
    const before = await read(orderId);

    await broker.publish(
      stockReservationFailed(attempt(orderId), [
        { productId: PRODUCT_ACME_ACTIVE, requested: 1, available: 0 },
      ]),
    );
    await drained();

    expect(await read(orderId)).toEqual(before);
    expect(await sagaOf(orderId)).toMatchObject({ step: 'CHARGING' });
  });

  it('a late "reserved" of the first attempt is not mistaken for the second', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    await broker.waitForSent('inventory.reserve-stock', id);
    await broker.publish(stockReserved(attempt(id)));
    await broker.waitForCommands(id);
    await broker.publish(paymentFailed(attempt(id), 'card_declined'));
    await settled(id, ['PAYMENT_FAILED']);
    await place(id, 3);
    await broker.waitForSent('inventory.reserve-stock', id, 2);

    await broker.publish(stockReserved(attempt(id, 1)));
    await drained();

    // the second attempt still waits for its own stock: no charge was asked for it
    expect(await sagaOf(id, 2)).toMatchObject({ step: 'RESERVING' });
    expect(broker.commands(id).map((command) => command.payload.paymentAttempt)).toEqual([1]);
  });
});

describe('an answer for an attempt that has no saga is parked (SAGA-013)', () => {
  it('parks "reserved" for an order of another workspace at once, and goes on', async () => {
    const { id } = await orderFactory.create({ workspaceId: WS_GLOBEX });

    // no saga of this order exists in acme: another delivery would not find one either
    await broker.publish(stockReserved(attempt(id, 1, WS_ACME)));
    const [message] = await waitFor(
      () => broker.take(INVENTORY_DEAD_LETTER_QUEUE),
      (taken) => taken.length > 0,
      { what: 'the answer in the dead-letter queue' },
    );
    await drained();

    expect(message?.headers).toMatchObject({
      'x-parked-from': INVENTORY_QUEUE,
      'x-last-error': expect.stringMatching(/^UnprocessableMessageError: ORDER_SAGA_NOT_FOUND/),
    });
    expect(message?.headers['x-parked-deaths']).toBeUndefined();
  });
});

describe('two workers get two answers of one saga at once (SAGA-012)', () => {
  let second: WorkerApp;
  beforeAll(async () => {
    second = await createWorkerApp(); // a second worker process, same database and queues
  });
  afterAll(() => second.close());

  it('one of them moves the saga: one charge is asked for, one STOCK_RESERVED is noted', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    await broker.waitForSent('inventory.reserve-stock', id);

    // two messages about one fact: prefetch is 1, so the broker hands one to each worker
    await Promise.all([
      broker.publish(stockReserved(attempt(id))),
      broker.publish(stockReserved(attempt(id))),
    ]);
    await broker.waitForCommands(id);
    await drained();
    await drained(); // one marker per worker

    expect(broker.commands(id)).toHaveLength(1);
    expect(await sagaOf(id)).toMatchObject({ step: 'CHARGING', version: 1 });
    expect((await history(id)).filter((entry) => entry.type === 'STOCK_RESERVED')).toHaveLength(1);
    // whoever lost the write got its message again and found the saga moved on
    expect(await broker.take(INVENTORY_DEAD_LETTER_QUEUE)).toEqual([]);
  });
});
