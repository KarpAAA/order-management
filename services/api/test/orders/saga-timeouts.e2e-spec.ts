// The timeouts of the saga steps (SAGA-007…010, 016), with the real broker doing the waiting:
// a timeout is a row of the outbox, published by the relay to a delay queue and handed to the
// worker when its delay is over. A file of its own: it runs with timeouts of a fraction of a
// second, where every other file has ones that never go off (.env.test).
// The test is inventory and payments, and mostly it is the one that does not answer.
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
import { USER_ACME_MEMBER, WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

// Before the apps of this file read their configuration. Three different values: each is a
// delay queue of its own, named after its delay.
const RESERVE_TIMEOUT_MS = 400;
const CHARGE_TIMEOUT_MS = 600;
const COMPENSATION_TIMEOUT_MS = 500;
process.env.ORDER_SAGA_RESERVE_TIMEOUT_MS = String(RESERVE_TIMEOUT_MS);
process.env.ORDER_SAGA_CHARGE_TIMEOUT_MS = String(CHARGE_TIMEOUT_MS);
process.env.ORDER_SAGA_COMPENSATION_TIMEOUT_MS = String(COMPENSATION_TIMEOUT_MS);

const TIMEOUTS_QUEUE = 'api.saga-timeouts';
const DELAY_QUEUES = [RESERVE_TIMEOUT_MS, CHARGE_TIMEOUT_MS, COMPENSATION_TIMEOUT_MS].map(
  (delayMs) => `${TIMEOUTS_QUEUE}.delay.${String(delayMs)}`,
);

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
const attempt = (orderId: string, paymentAttempt = 1) => ({
  workspaceId: WS_ACME,
  orderId,
  paymentAttempt,
});

async function place(orderId: string): Promise<number> {
  await api
    .http()
    .post(`${orderPath(WS_ACME, orderId)}/place`)
    .set(member)
    .send({ version: 0 })
    .expect(202);
  await broker.waitForSent('inventory.reserve-stock', orderId);
  return Date.now();
}

/** A placed order whose stock is reserved: its saga waits for the answer of payments. */
async function charging(): Promise<string> {
  const { id } = await orderFactory.create();
  await place(id);
  await broker.publish(stockReserved(attempt(id)));
  await broker.waitForCommands(id);
  return id;
}

async function read(orderId: string): Promise<Record<string, unknown>> {
  const { body } = await api.http().get(orderPath(WS_ACME, orderId)).set(member).expect(200);
  return body as Record<string, unknown>;
}

async function historyTypes(orderId: string): Promise<string[]> {
  const { body } = await api
    .http()
    .get(`${orderPath(WS_ACME, orderId)}/events`)
    .set(member)
    .expect(200);
  return (body as { items: { type: string }[] }).items.map((entry) => entry.type);
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

/**
 * Plays inventory to the end of a saga that compensates: confirms the release it asked for.
 * Every test ends its sagas: one left in RELEASING asks again on every timeout (SAGA-009),
 * for as long as the file runs.
 */
async function released(orderId: string): Promise<void> {
  await broker.waitForSent('inventory.release-stock', orderId);
  await broker.publish(stockReleased(attempt(orderId)));
  await sagaIn(orderId, 'ABORTED');
}

/** Until every timeout that was written has gone off and was handled. */
async function timeoutsOver(): Promise<void> {
  await waitFor(
    async () => {
      const waiting = await testDb().outboxMessage.count({
        where: { exchange: 'api.delayed', publishedAt: null },
      });
      const depths = await Promise.all(
        [...DELAY_QUEUES, TIMEOUTS_QUEUE].map((queue) => broker.depth(queue)),
      );
      return waiting + depths.reduce((sum, depth) => sum + depth, 0);
    },
    (left) => left === 0,
    { what: 'every timeout to go off' },
  );
  // the one the worker may be handling right now: its queue is empty, its work is not done
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe('inventory does not answer the reservation (SAGA-007)', () => {
  let orderId: string;
  let placedAt: number;

  it('gives the order back as a DRAFT after the timeout, and releases in the dark', async () => {
    orderId = (await orderFactory.create()).id;
    placedAt = await place(orderId);

    const order = await settled(orderId, ['DRAFT']);
    const [release] = await broker.waitForSent('inventory.release-stock', orderId);

    // not before its time: the broker kept the timeout for the delay of the step
    expect(Date.now() - placedAt).toBeGreaterThanOrEqual(RESERVE_TIMEOUT_MS - 100);
    expect(order).toMatchObject({
      failureReason: 'inventory_unavailable',
      placedAt: null,
      version: 2,
    });
    expect(release).toMatchObject({ workspaceId: WS_ACME, payload: { orderId, attempt: 1 } });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'RELEASING' });
    expect(await historyTypes(orderId)).toEqual([
      'ORDER_CREATED',
      'ORDER_PLACED',
      'STOCK_RESERVATION_FAILED',
    ]);
  });

  it('SAGA-016 the release belongs to the chain of the request that placed the order', () => {
    const [reservation] = broker.sent('inventory.reserve-stock', orderId);
    const [release] = broker.sent('inventory.release-stock', orderId);

    expect(release?.correlationId).toBe(reservation?.correlationId);
  });

  it('a "reserved" that arrives after it asks for no charge: the release takes that stock back', async () => {
    await broker.publish(stockReserved(attempt(orderId)));
    await broker.publish(stockReleased(attempt(orderId)));
    await sagaIn(orderId, 'ABORTED');

    expect(broker.commands(orderId)).toEqual([]);
    expect(await read(orderId)).toMatchObject({
      status: 'DRAFT',
      failureReason: 'inventory_unavailable',
    });
    expect((await historyTypes(orderId)).at(-1)).toBe('STOCK_RELEASED');
  });
});

describe('payments does not answer the charge (SAGA-008)', () => {
  it('asks payments to cancel it and decides nothing: the order still waits', async () => {
    const orderId = await charging();

    const [cancel] = await broker.waitForSent('payments.cancel-payment', orderId);
    const saga = await sagaIn(orderId, 'CANCELLING_PAYMENT');

    expect(cancel).toMatchObject({
      name: 'payments.cancel-payment',
      workspaceId: WS_ACME,
      payload: { orderId, paymentAttempt: 1 },
    });
    expect(saga.deadlineAt).not.toBeNull();
    expect(await read(orderId)).toMatchObject({ status: 'PENDING_PAYMENT', failureReason: null });
    expect((await historyTypes(orderId)).at(-1)).toBe('PAYMENT_TIMED_OUT');
    // no money question is open on the side of inventory yet: nothing is released
    expect(broker.sent('inventory.release-stock', orderId)).toEqual([]);

    await broker.publish(paymentCancelled(attempt(orderId)));
    await settled(orderId, ['PAYMENT_FAILED']);
    await released(orderId);
  });

  it('the charge it asked for expired with the step: payments would charge nothing now', async () => {
    const orderId = await charging();
    const [charge] = broker.commands(orderId);

    await broker.waitForSent('payments.cancel-payment', orderId);

    expect(Date.parse(charge?.payload.expiresAt ?? '')).toBeLessThanOrEqual(Date.now());
    await broker.publish(paymentCancelled(attempt(orderId)));
    await settled(orderId, ['PAYMENT_FAILED']);
    await released(orderId);
  });

  it('"cancelled" ends the attempt as payment_timeout and releases the stock', async () => {
    const orderId = await charging();
    await broker.waitForSent('payments.cancel-payment', orderId);

    await broker.publish(paymentCancelled(attempt(orderId)));
    const order = await settled(orderId, ['PAYMENT_FAILED']);
    await released(orderId);

    expect(order).toMatchObject({ failureReason: 'payment_timeout' });
    expect(await historyTypes(orderId)).toEqual([
      'ORDER_CREATED',
      'ORDER_PLACED',
      'STOCK_RESERVED',
      'PAYMENT_TIMED_OUT',
      'PAYMENT_FAILED',
      'STOCK_RELEASED',
    ]);
  });

  it('"succeeded" after the timeout pays the order: the charge was made first', async () => {
    const orderId = await charging();
    await broker.waitForSent('payments.cancel-payment', orderId);

    await broker.publish(paymentSucceeded(attempt(orderId), 'ch_late'));
    const order = await settled(orderId, ['PAID']);
    await timeoutsOver();

    expect(order).toMatchObject({ pspChargeId: 'ch_late' });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'COMPLETED', deadlineAt: null });
    expect(broker.sent('inventory.release-stock', orderId)).toEqual([]);
  });

  it('"failed" after the timeout keeps the reason payments gave', async () => {
    const orderId = await charging();
    await broker.waitForSent('payments.cancel-payment', orderId);

    await broker.publish(paymentFailed(attempt(orderId), 'expired'));

    expect(await settled(orderId, ['PAYMENT_FAILED'])).toMatchObject({ failureReason: 'expired' });
    await released(orderId);
  });
});

describe('a compensation that is not answered is asked for again (SAGA-009)', () => {
  it('asks payments again while the cancellation is open, and changes nothing about the order', async () => {
    const orderId = await charging();

    const cancels = await broker.waitForSent('payments.cancel-payment', orderId, 2);
    const before = await read(orderId);

    expect(new Set(cancels.map((command) => command.messageId)).size).toBe(2);
    expect(before).toMatchObject({ status: 'PENDING_PAYMENT' });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'CANCELLING_PAYMENT' });
    // one PAYMENT_TIMED_OUT: the repetition has nothing new to tell
    expect(
      (await historyTypes(orderId)).filter((type) => type === 'PAYMENT_TIMED_OUT'),
    ).toHaveLength(1);

    await broker.publish(paymentCancelled(attempt(orderId)));
    await settled(orderId, ['PAYMENT_FAILED']);
    await released(orderId);
  });

  it('asks inventory again while the release is not confirmed', async () => {
    const orderId = await charging();
    await broker.publish(paymentFailed(attempt(orderId), 'card_declined'));
    await settled(orderId, ['PAYMENT_FAILED']);

    const releases = await broker.waitForSent('inventory.release-stock', orderId, 2);

    expect(new Set(releases.map((command) => command.messageId)).size).toBe(2);
    expect(await read(orderId)).toMatchObject({
      status: 'PAYMENT_FAILED',
      failureReason: 'card_declined',
    });
    expect(await sagaOf(orderId)).toMatchObject({ step: 'RELEASING' });

    await broker.publish(stockReleased(attempt(orderId)));
    await sagaIn(orderId, 'ABORTED');
  });
});

describe('a step that was answered in time (SAGA-010)', () => {
  it('its timeout goes off and changes nothing: paid stays paid, and nothing is compensated', async () => {
    const orderId = await charging();
    await broker.publish(paymentSucceeded(attempt(orderId), 'ch_in_time'));
    const paid = await settled(orderId, ['PAID']);

    await timeoutsOver();

    expect(await read(orderId)).toEqual(paid);
    expect(await sagaOf(orderId)).toMatchObject({ step: 'COMPLETED' });
    expect(broker.sent('payments.cancel-payment', orderId)).toEqual([]);
    expect(broker.sent('inventory.release-stock', orderId)).toEqual([]);
    expect(await historyTypes(orderId)).toEqual([
      'ORDER_CREATED',
      'ORDER_PLACED',
      'STOCK_RESERVED',
      'PAYMENT_SUCCEEDED',
    ]);
    // acknowledged, not given up: nothing was parked
    expect(await broker.take(`${TIMEOUTS_QUEUE}.dlq`)).toEqual([]);
  });
});
