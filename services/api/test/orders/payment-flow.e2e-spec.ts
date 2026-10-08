// The payment path of the api, to its boundary (PAY-001…013): HTTP place → commit, with
// `payments.charge-payment` in the outbox → the relay of the WORKER app publishes it to
// RabbitMQ; `payments.payment-succeeded` / `-failed` comes back → PaymentEventsConsumer in the
// WORKER app → PAID / PAYMENT_FAILED. The outbox itself: test/outbox/.
// payments-service is not here: the test is the other side of the broker (helpers/broker.ts),
// and that service has the same kind of suite of its own. The full path is ROADMAP 3.13.
// The API answers 202 before any of that, so the test does what a client does: polls
// GET /orders/{id}. Every assertion is on an outcome (message, row, history), never on "a
// method was called".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import {
  connectTestBroker,
  paymentFailed,
  paymentSucceeded,
  type TestBroker,
} from '../helpers/broker';
import { DATABASE_LOST, failToLoad } from '../helpers/failing-orders';
import { orderPath } from '../helpers/paths';
import { waitFor, waitForStatus } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { USER_ACME_MEMBER, USER_GLOBEX_MEMBER, WS_ACME, WS_GLOBEX } from '../seed/ids';
import { testDb } from '../setup/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the queues the worker declares for itself: names on the wire, so the test spells them out
const EVENTS_QUEUE = 'api.payment-events';
// .env.test: an event that failed waits 200 ms, and its third delivery is the last
const WAIT_QUEUE = 'api.payment-events.wait.200';
const DEAD_LETTER_QUEUE = 'api.payment-events.dlq';
const MAX_ATTEMPTS = 3;

let api: ApiApp;
let worker: WorkerApp;
let broker: TestBroker;

beforeAll(async () => {
  // first: its queue must be bound before the api publishes anything
  broker = await connectTestBroker();
  api = await createApiApp();
  worker = await createWorkerApp();
});
// the API app holds a Prisma pool and Redis: it closes even when closing the worker fails
afterAll(async () => {
  try {
    await worker.close();
  } finally {
    await api.close();
    await broker.close();
  }
});

const member = asUser(USER_ACME_MEMBER);
const FINAL = ['PAID', 'PAYMENT_FAILED'] as const;

async function place(orderId: string, version = 0, ws = WS_ACME, as = member) {
  await api
    .http()
    .post(`${orderPath(ws, orderId)}/place`)
    .set(as)
    .send({ version })
    .expect(202);
}
const settle = (orderId: string, ws = WS_ACME, as = member) =>
  waitForStatus(api, orderPath(ws, orderId), as, FINAL);

const attempt = (orderId: string, paymentAttempt = 1, workspaceId = WS_ACME) => ({
  workspaceId,
  orderId,
  paymentAttempt,
});

async function stored(orderId: string) {
  const row = await testDb().order.findFirstOrThrow({ where: { id: orderId } });
  const history = await testDb().orderEvent.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
  return {
    status: row.status,
    version: row.version,
    attempt: row.paymentAttempt,
    history: history.map((e) => e.type),
  };
}

const noneWaiting = () =>
  waitFor(
    () => broker.depth(WAIT_QUEUE),
    (depth) => depth === 0,
    { what: 'the wait queue to be empty' },
  );

/**
 * Proof that every event published before this call has been handled: the worker takes one
 * message at a time (RABBITMQ_PREFETCH=1), so an order placed and paid after them is behind
 * them in the queue. An event that failed is not in that queue while it waits for its next
 * delivery, so nothing may be waiting before the marker goes in, nor after it came out.
 */
async function drained(): Promise<void> {
  await noneWaiting();
  const { id } = await orderFactory.create();
  await place(id);
  await broker.publish(paymentSucceeded(attempt(id), 'ch_marker'));
  await settle(id);
  await noneWaiting();
}

const parked = () =>
  waitFor(
    () => broker.take(DEAD_LETTER_QUEUE),
    (taken) => taken.length > 0,
    { what: 'a message in the dead-letter queue' },
  );

describe('place → the api asks payments-service for the charge (PAY-001, PAY-003)', () => {
  it('sends charge-payment with the total, the attempt and the key <id>:1, in the order workspace', async () => {
    const { id } = await orderFactory.create();

    await place(id);
    const [command] = await broker.waitForCommands(id);
    const { body: order } = await api.http().get(orderPath(WS_ACME, id)).set(member).expect(200);

    expect(command).toMatchObject({
      name: 'payments.charge-payment',
      version: 1,
      workspaceId: WS_ACME,
      payload: {
        orderId: id,
        paymentAttempt: 1,
        amount: (order as { totals: { total: unknown } }).totals.total,
        idempotencyKey: `${id}:1`,
      },
    });
    expect(command?.messageId).toMatch(UUID);
    expect(command?.correlationId).toMatch(UUID);
    // the answer has not come: the order waits
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', paymentAttempt: 1 });
  });

  it('sends one command per place, in the currency of the workspace (PAY-002, PAY-012)', async () => {
    const globexMember = asUser(USER_GLOBEX_MEMBER);
    const { id } = await orderFactory.create({ workspaceId: WS_GLOBEX });

    await place(id, 0, WS_GLOBEX, globexMember);
    const commands = await broker.waitForCommands(id);
    await drained();

    expect(broker.commands(id)).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      workspaceId: WS_GLOBEX,
      payload: { amount: { currency: 'USD' } },
    });
  });
});

describe('payment-succeeded → PAID (PAY-004)', () => {
  it('records the charge id, the time and the history entry of the consumer', async () => {
    const { id } = await orderFactory.create();
    await place(id);

    await broker.publish(paymentSucceeded(attempt(id), 'ch_42'));
    const order = await settle(id);

    expect(order).toMatchObject({ status: 'PAID', pspChargeId: 'ch_42', version: 2 });
    expect(order.paidAt).toEqual(expect.any(String));
    const { body } = await api
      .http()
      .get(`${orderPath(WS_ACME, id)}/events`)
      .set(member)
      .expect(200);
    expect((body as { items: unknown[] }).items.at(-1)).toMatchObject({
      type: 'PAYMENT_SUCCEEDED',
      fromStatus: 'PENDING_PAYMENT',
      toStatus: 'PAID',
      actor: 'system:consumer:orders',
      payload: { paymentAttempt: 1, pspChargeId: 'ch_42' },
    });
  });
});

describe('payment-failed → PAYMENT_FAILED (PAY-005, PAY-007, PAY-008)', () => {
  it.each(['insufficient_funds', 'psp_unavailable', 'psp_rejected'])(
    'keeps %s as the failure reason',
    async (declineCode) => {
      const { id } = await orderFactory.create();
      await place(id);

      await broker.publish(paymentFailed(attempt(id), declineCode));
      const order = await settle(id);

      expect(order).toMatchObject({ status: 'PAYMENT_FAILED', failureReason: declineCode });
      const { body } = await api
        .http()
        .get(`${orderPath(WS_ACME, id)}/events`)
        .set(member)
        .expect(200);
      expect((body as { items: unknown[] }).items.at(-1)).toMatchObject({
        type: 'PAYMENT_FAILED',
        actor: 'system:consumer:orders',
        payload: { paymentAttempt: 1, reason: declineCode },
      });
    },
  );
});

describe('the tenant comes from the envelope (PAY-012)', () => {
  const globexMember = asUser(USER_GLOBEX_MEMBER);

  it('settles a globex order in globex', async () => {
    const { id } = await orderFactory.create({ workspaceId: WS_GLOBEX });
    await place(id, 0, WS_GLOBEX, globexMember);

    await broker.publish(paymentSucceeded(attempt(id, 1, WS_GLOBEX), 'ch_globex'));

    expect((await settle(id, WS_GLOBEX, globexMember)).status).toBe('PAID');
  });

  it('does not find a globex order under an acme envelope: nothing is written, the event is parked', async () => {
    const { id } = await orderFactory.create({ workspaceId: WS_GLOBEX });
    await place(id, 0, WS_GLOBEX, globexMember);
    const before = await stored(id);

    await broker.publish(paymentSucceeded(attempt(id, 1, WS_ACME), 'ch_wrong_tenant'));
    const [event] = await parked();
    await drained();

    expect(await stored(id)).toEqual(before);
    // at once: the order will not be in acme on a later delivery either
    expect(event?.headers).toMatchObject({
      'x-parked-from': EVENTS_QUEUE,
      'x-last-error': expect.stringMatching(/^UnprocessableMessageError: ORDER_NOT_FOUND/),
    });
    expect(event?.headers['x-parked-deaths']).toBeUndefined();
  });
});

describe('an outcome is recorded once (PAY-009, PAY-010)', () => {
  it('the same event delivered twice changes nothing the second time', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    const event = paymentSucceeded(attempt(id), 'ch_once');

    await broker.publish(event);
    await settle(id);
    const before = await stored(id);
    await broker.publish(event);
    await drained();

    expect(await stored(id)).toEqual(before);
    expect(before.history.filter((type) => type === 'PAYMENT_SUCCEEDED')).toHaveLength(1);
  });

  it('IBX-001 the same message five times is handled once: one record, one order-paid', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    const event = paymentSucceeded(attempt(id), 'ch_five');

    for (let delivery = 0; delivery < 5; delivery += 1) await broker.publish(event);
    await settle(id);
    await drained();

    const after = await stored(id);
    expect(after).toMatchObject({ status: 'PAID', version: 2 });
    expect(after.history.filter((type) => type === 'PAYMENT_SUCCEEDED')).toHaveLength(1);
    expect(await testDb().inboxMessage.findMany({ where: { messageId: event.messageId } })).toEqual(
      [expect.objectContaining({ consumer: EVENTS_QUEUE })],
    );
    const paid = (await broker.waitForOrderEvents(id, 2)).filter(
      (e) => e.name === 'orders.order-paid',
    );
    expect(paid).toHaveLength(1);
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
  });

  it('a failure that arrives after the success does not undo it', async () => {
    const { id } = await orderFactory.create();
    await place(id);

    await broker.publish(paymentSucceeded(attempt(id), 'ch_first'));
    await settle(id);
    await broker.publish(paymentFailed(attempt(id), 'psp_unavailable'));
    await drained();

    expect(await stored(id)).toMatchObject({ status: 'PAID', version: 2 });
  });
});

describe('two workers get the same outcome at once (PAY-010)', () => {
  let second: WorkerApp;
  beforeAll(async () => {
    second = await createWorkerApp(); // a second worker process, same database and queue
  });
  afterAll(() => second.close());

  it('one of them records it: one PAID, one history entry', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    const event = paymentSucceeded(attempt(id), 'ch_race');

    // prefetch is 1: the broker hands one delivery to each worker
    await Promise.all([broker.publish(event), broker.publish(event)]);
    await settle(id);
    await drained();
    await drained(); // one marker per worker

    const after = await stored(id);
    expect(after).toMatchObject({ status: 'PAID', version: 2 });
    expect(after.history.filter((type) => type === 'PAYMENT_SUCCEEDED')).toHaveLength(1);
    // the worker that lost the write got the event again and found the order settled
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
  });
});

describe('a new attempt after a failure (PAY-009, PAY-011)', () => {
  it('asks for attempt 2 with its own key; a late answer for attempt 1 then does nothing', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    await broker.publish(paymentFailed(attempt(id, 1), 'card_declined'));
    expect((await settle(id)).status).toBe('PAYMENT_FAILED');

    await place(id, 2); // place → 1, payment failed → 2
    const commands = await broker.waitForCommands(id, 2);
    expect(commands.map((c) => [c.payload.paymentAttempt, c.payload.idempotencyKey])).toEqual([
      [1, `${id}:1`],
      [2, `${id}:2`],
    ]);

    // the answer for attempt 1 arrives again, late: the order waits for attempt 2
    const before = await stored(id);
    await broker.publish(paymentSucceeded(attempt(id, 1), 'ch_late'));
    await drained();
    expect(await stored(id)).toEqual(before);

    await broker.publish(paymentSucceeded(attempt(id, 2), 'ch_second'));
    expect(await settle(id)).toMatchObject({
      status: 'PAID',
      paymentAttempt: 2,
      pspChargeId: 'ch_second',
      failureReason: null,
    });
  });
});

describe('an event whose handling fails is delivered again (PAY-016, PAY-017)', () => {
  it('is recorded on the delivery the database is back for', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    failToLoad(worker, id, MAX_ATTEMPTS - 1);

    await broker.publish(paymentSucceeded(attempt(id), 'ch_retried'));
    const order = await settle(id);
    await drained();

    expect(order).toMatchObject({ status: 'PAID', pspChargeId: 'ch_retried', version: 2 });
    expect((await stored(id)).history.filter((type) => type === 'PAYMENT_SUCCEEDED')).toHaveLength(
      1,
    );
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
  });

  it('is parked after the last delivery, and recorded when it is put back', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    const repair = failToLoad(worker, id);
    const event = paymentSucceeded(attempt(id), 'ch_parked');

    await broker.publish(event);
    const [message] = await parked();

    // the event as it was published, with where it came from and why it was given up
    expect(JSON.parse(message?.content.toString() ?? '')).toMatchObject({
      messageId: event.messageId,
    });
    expect(message?.headers).toMatchObject({
      'x-parked-from': EVENTS_QUEUE,
      'x-last-error': `Error: ${DATABASE_LOST}`,
      'x-parked-deaths': expect.arrayContaining([
        expect.objectContaining({
          queue: EVENTS_QUEUE,
          reason: 'rejected',
          count: MAX_ATTEMPTS - 1,
        }),
      ]),
    });
    // the charge is made and the order does not know: this is what the dead-letter queue is for
    expect(await stored(id)).toMatchObject({ status: 'PENDING_PAYMENT', version: 1 });

    // the operator fixed the cause and moves the message back
    repair();
    if (message) broker.put(EVENTS_QUEUE, message.content, message.headers);

    expect(await settle(id)).toMatchObject({ status: 'PAID', pspChargeId: 'ch_parked' });
  });
});

describe('a message that is not a known event is parked at once, and the worker goes on (PAY-015)', () => {
  it.each([
    ['bytes that are not JSON', Buffer.from('not json')],
    ['JSON that is not a message', Buffer.from(JSON.stringify({ hello: 'world' }))],
    [
      'an event that breaks its contract',
      Buffer.from(
        JSON.stringify({
          ...paymentSucceeded(attempt('01990000-0000-7000-8000-a20000000001'), 'ch_1'),
          payload: { orderId: 'not-a-uuid' },
        }),
      ),
    ],
  ])('%s', async (_, content) => {
    const { id } = await orderFactory.create();
    await place(id);

    broker.publishRaw('payments.payment-succeeded', content);
    // the next event is served: the bad one was not put back in front of it
    await broker.publish(paymentSucceeded(attempt(id), 'ch_after_bad'));

    expect((await settle(id)).status).toBe('PAID');
    // kept as it came, for whoever has to find out who sent it
    const messages = await broker.take(DEAD_LETTER_QUEUE);
    expect(messages.map((message) => message.content)).toEqual([content]);
    expect(messages[0]?.headers).toMatchObject({
      'x-parked-from': EVENTS_QUEUE,
      'x-last-error': expect.stringMatching(/^UnprocessableMessageError: /),
    });
  });
});
