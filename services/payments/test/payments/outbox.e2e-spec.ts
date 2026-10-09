// The answer of the service goes through its outbox (OBX-001, 002, 009, 010): the row that
// says how the attempt ended and the message that tells the api are one transaction, and the
// relay of the process publishes the message. The relay itself, pass by pass, is tested in
// the api (services/api/test/outbox): the code is a copy.
import { ChargePaymentV1, PaymentSucceededV1 } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONNECTION_NAME } from '@infra/messaging/rabbit-connection';

import { TestPsp } from '../doubles/test-psp';
import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { failInsertsInto } from '../helpers/failing-inserts';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

const WORKSPACE = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02';
const DAY_MS = 24 * 60 * 60 * 1000;

const psp = new TestPsp();
let broker: TestBroker;
let service: WorkerApp;

beforeAll(async () => {
  // first: its queue must be bound before the service publishes anything
  broker = await connectTestBroker();
  service = await createWorkerApp(psp);
});
afterAll(async () => {
  try {
    await service.close();
  } finally {
    await broker.close();
  }
});

const chargeCommand = (orderId: string): ChargePaymentV1 =>
  ChargePaymentV1.create(
    {
      messageId: uuidv7(),
      occurredAt: new Date(),
      workspaceId: WORKSPACE,
      correlationId: uuidv7(),
    },
    {
      orderId,
      paymentAttempt: 1,
      amount: { amountMinor: 12_50, currency: 'EUR' },
      idempotencyKey: `${orderId}:1`,
    },
  );

const payment = (orderId: string) =>
  testDb().payment.findFirstOrThrow({ where: { orderId }, select: { status: true } });

/** The outbox rows about the order, oldest first. */
const outboxOf = (orderId: string) =>
  testDb().outboxMessage.findMany({
    where: { payload: { path: ['payload', 'orderId'], equals: orderId } },
    orderBy: { id: 'asc' },
  });

const published = (orderId: string) =>
  waitFor(
    () => outboxOf(orderId),
    (rows) => rows.length > 0 && rows.every((row) => row.publishedAt !== null),
    { what: `every outbox row of order ${orderId} to be published` },
  );

describe('the answer is a row of the outbox (OBX-001, OBX-002)', () => {
  it('is the message the api receives: same id, events exchange, marked published', async () => {
    const orderId = uuidv7();

    await broker.send(chargeCommand(orderId));
    const [event] = await broker.waitForEvents(orderId);
    const [row] = await published(orderId);

    expect(row).toMatchObject({
      id: event?.messageId,
      exchange: 'events',
      routingKey: 'payments.payment-succeeded',
    });
    expect(row?.payload).toEqual(event);
  });

  it('is not written without the settled row, nor the row without it: the next delivery does both', async () => {
    const orderId = uuidv7();
    const restore = await failInsertsInto('outbox');
    try {
      await broker.send(chargeCommand(orderId));
      // charged at the provider, and the transaction that would record it failed
      await waitFor(
        () => Promise.resolve(psp.calls(orderId).length),
        (calls) => calls >= 1,
        { what: 'the first call to the PSP' },
      );

      expect(await payment(orderId)).toEqual({ status: 'PENDING' });
      expect(await outboxOf(orderId)).toEqual([]);
      expect(broker.events(orderId)).toEqual([]);
    } finally {
      await restore();
    }

    // the command comes again after the delay: the provider answers the same, by its key
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({ name: 'payments.payment-succeeded' });
    expect(await payment(orderId)).toEqual({ status: 'SUCCEEDED' });
    expect(psp.charges(orderId)).toHaveLength(1);
    expect(await published(orderId)).toHaveLength(1);
    expect(broker.events(orderId)).toHaveLength(1);
  });
});

describe('the broker goes away (OBX-010)', () => {
  it('a message committed while the connection is down is published when it is back', async () => {
    const orderId = uuidv7();
    const answer = PaymentSucceededV1.create(
      {
        messageId: uuidv7(),
        occurredAt: new Date(),
        workspaceId: WORKSPACE,
        correlationId: uuidv7(),
      },
      { orderId, paymentAttempt: 1, chargeId: 'ch_while_down' },
    );

    // what the relay sees when the broker restarts: its connection is gone
    await broker.killConnection(CONNECTION_NAME);
    // …and a transaction commits an answer meanwhile. Written straight into the table: a
    // command could not reach the service now, its consumer is on the same connection.
    await testDb().outboxMessage.create({
      data: {
        id: answer.messageId,
        exchange: 'events',
        routingKey: answer.name,
        payload: answer,
        occurredAt: new Date(answer.occurredAt),
      },
    });

    const events = await broker.waitForEvents(orderId);
    await published(orderId);

    // at least once: a publish the broker had and never confirmed is sent again
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(new Set(events.map((event) => event.messageId))).toEqual(new Set([answer.messageId]));
  }, 60_000);
});

describe('retention (OBX-009)', () => {
  it('a process that starts deletes the messages published before the retention, and only those', async () => {
    const now = Date.now();
    const [old, recent, stuck] = [uuidv7(), uuidv7(), uuidv7()];
    const row = (id: string, publishedAt: Date | null) => ({
      id,
      exchange: 'events',
      routingKey: 'payments.test-retention',
      payload: { messageId: id, name: 'payments.test-retention' },
      occurredAt: new Date(now - 30 * DAY_MS),
      createdAt: new Date(now - 30 * DAY_MS),
      publishedAt,
    });
    await testDb().outboxMessage.createMany({
      data: [
        row(old, new Date(now - 8 * DAY_MS)),
        row(recent, new Date(now - 6 * DAY_MS)),
        // never published, however old: it still has to go out
        row(stuck, null),
      ],
    });

    const second = await createWorkerApp(psp);
    try {
      await waitFor(
        () => testDb().outboxMessage.findUnique({ where: { id: old } }),
        (gone) => gone === null,
        { what: 'the old published message to be deleted' },
      );

      const left = await testDb().outboxMessage.findMany({
        where: { id: { in: [old, recent, stuck] } },
        orderBy: { id: 'asc' },
      });
      expect(left.map((r) => r.id)).toEqual([recent, stuck].sort());
    } finally {
      await second.close();
    }
  });
});
