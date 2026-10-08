// The outbox from the outside (OBX-001, 002, 007, 008): what the api commits and what reaches
// the broker, with the two processes started one after the other. The api app writes rows and
// never publishes them; the worker app runs the relay. A file of its own: the first test
// needs a moment in which no worker exists.
// Since the saga (3.7) `place` asks inventory first; the test broker answers "reserved" at
// once, and the charge command follows from the worker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { connectTestBroker, paymentSucceeded, type TestBroker } from '../helpers/broker';
import { orderPath } from '../helpers/paths';
import { waitFor, waitForStatus } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { USER_ACME_ADMIN, USER_ACME_MEMBER, WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

let api: ApiApp;
let worker: WorkerApp | undefined;
let broker: TestBroker;

beforeAll(async () => {
  // first: its queues must be bound before anything is published
  broker = await connectTestBroker();
  api = await createApiApp();
});
afterAll(async () => {
  try {
    await worker?.close();
  } finally {
    await api.close();
    await broker.close();
  }
});

const member = asUser(USER_ACME_MEMBER);
const admin = asUser(USER_ACME_ADMIN);

const act = (orderId: string, action: string, as = member, expected = 204) =>
  api
    .http()
    .post(`${orderPath(WS_ACME, orderId)}/${action}`)
    .set(as)
    .send({ version: 0 })
    .expect(expected);

interface Row {
  exchange: string;
  routingKey: string;
  published: boolean;
}

/** The outbox rows about the order, oldest first. */
async function outboxOf(orderId: string): Promise<Row[]> {
  const rows = await testDb().outboxMessage.findMany({
    where: { payload: { path: ['payload', 'orderId'], equals: orderId } },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({
    exchange: row.exchange,
    routingKey: row.routingKey,
    published: row.publishedAt !== null,
  }));
}

const allPublished = (orderId: string) =>
  waitFor(
    () => outboxOf(orderId),
    (rows) => rows.length > 0 && rows.every((row) => row.published),
    { what: `every outbox row of order ${orderId} to be published` },
  );

// .env.test: ORDER_SAGA_RESERVE_TIMEOUT_MS and ORDER_SAGA_CHARGE_TIMEOUT_MS
const RESERVE_TIMEOUT = 'api.saga-timeouts.delay.600000';
const CHARGE_TIMEOUT = 'api.saga-timeouts.delay.900000';

describe('place commits the order and its messages; the relay publishes them (OBX-001, OBX-002)', () => {
  let orderId: string;

  it('with no relay running: 202, the order waits, the command and the event wait in the outbox', async () => {
    orderId = (await orderFactory.create()).id;

    await act(orderId, 'place', member, 202);

    const order = await testDb().order.findFirstOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(await outboxOf(orderId)).toEqual(
      expect.arrayContaining([
        { exchange: 'commands', routingKey: 'inventory.reserve-stock', published: false },
        { exchange: 'api.delayed', routingKey: RESERVE_TIMEOUT, published: false },
        { exchange: 'events', routingKey: 'orders.order-placed', published: false },
      ]),
    );
    expect(await outboxOf(orderId)).toHaveLength(3);
    // nothing has left the database: no process of this file publishes
    expect(broker.sent('inventory.reserve-stock', orderId)).toEqual([]);
    expect(broker.orderEvents(orderId)).toEqual([]);
  });

  it('when the worker starts: they are published, once, and marked, and the saga goes on', async () => {
    worker = await createWorkerApp();

    const [reservation] = await broker.waitForSent('inventory.reserve-stock', orderId);
    const [event] = await broker.waitForOrderEvents(orderId);
    // the test broker said "reserved": the worker asks for the charge
    const [command] = await broker.waitForCommands(orderId);
    const rows = await allPublished(orderId);

    expect(rows.map((row) => `${row.exchange}:${row.routingKey}`).sort()).toEqual([
      `api.delayed:${RESERVE_TIMEOUT}`,
      `api.delayed:${CHARGE_TIMEOUT}`,
      'commands:inventory.reserve-stock',
      'commands:payments.charge-payment',
      'events:orders.order-placed',
    ]);
    expect(reservation).toMatchObject({
      name: 'inventory.reserve-stock',
      workspaceId: WS_ACME,
      payload: { orderId, attempt: 1, lines: [{ quantity: 1 }] },
    });
    expect(command).toMatchObject({
      name: 'payments.charge-payment',
      payload: { orderId, paymentAttempt: 1, idempotencyKey: `${orderId}:1` },
    });
    expect(event).toMatchObject({
      name: 'orders.order-placed',
      workspaceId: WS_ACME,
      payload: { orderId, paymentAttempt: 1, amount: command?.payload.amount },
    });
    expect(broker.sent('inventory.reserve-stock', orderId)).toHaveLength(1);
    expect(broker.commands(orderId)).toHaveLength(1);
    expect(broker.orderEvents(orderId)).toHaveLength(1);
  });

  it('the id of a message on the broker is the id of its row', async () => {
    const [command] = broker.commands(orderId);

    const row = await testDb().outboxMessage.findUnique({
      where: { id: command?.messageId ?? '' },
    });

    expect(row).toMatchObject({ exchange: 'commands', routingKey: 'payments.charge-payment' });
    expect(row?.payload).toEqual(command);
  });

  it('OBX-008 the commands and the event one request causes share a correlation id', () => {
    const [reservation] = broker.sent('inventory.reserve-stock', orderId);
    const [command] = broker.commands(orderId);
    const [event] = broker.orderEvents(orderId);

    expect(event?.correlationId).toBe(reservation?.correlationId);
    expect(event?.messageId).not.toBe(reservation?.messageId);
    // the charge follows the answer of inventory, which is in the chain of the reservation
    expect(command?.correlationId).toBe(reservation?.correlationId);
  });
});

describe('the life of an order as its subscribers see it (OBX-007, OBX-008)', () => {
  it('paid: orders.order-paid follows the answer of payments, in the chain of that answer', async () => {
    const { id } = await orderFactory.create();
    await act(id, 'place', member, 202);
    const [command] = await broker.waitForCommands(id);
    const answer = {
      ...paymentSucceeded({ workspaceId: WS_ACME, orderId: id, paymentAttempt: 1 }, 'ch_obx'),
      // payments answers in the chain of the command
      correlationId: command?.correlationId ?? '',
    };

    await broker.publish(answer);
    await waitForStatus(api, orderPath(WS_ACME, id), member, ['PAID']);
    const events = await broker.waitForOrderEvents(id, 2);

    expect(events.map((e) => e.name)).toEqual(['orders.order-placed', 'orders.order-paid']);
    expect(events[1]).toMatchObject({
      workspaceId: WS_ACME,
      correlationId: command?.correlationId,
      payload: { orderId: id, paymentAttempt: 1, chargeId: 'ch_obx' },
    });
  });

  it('cancelled: orders.order-cancelled', async () => {
    const { id } = await orderFactory.create();

    await act(id, 'cancel');
    const events = await broker.waitForOrderEvents(id);

    expect(events).toMatchObject([{ name: 'orders.order-cancelled', payload: { orderId: id } }]);
  });

  it('fulfilled: orders.order-fulfilled', async () => {
    const { id } = await orderFactory.create({ status: 'PAID' });

    await act(id, 'fulfill', admin);
    const events = await broker.waitForOrderEvents(id);

    expect(events).toMatchObject([{ name: 'orders.order-fulfilled', payload: { orderId: id } }]);
  });

  it('a request that is refused leaves no message', async () => {
    const { id } = await orderFactory.create({ status: 'PAID' });

    await act(id, 'cancel', member, 422);

    expect(await outboxOf(id)).toEqual([]);
  });
});
