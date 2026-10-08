// The inbox of the service (IBX-002, IBX-005): the record of a command is part of the
// transaction that settles the payment and writes the answer, and old records are deleted.
// What a repeated command does: charge-payment.e2e-spec.ts (IBX-001, IBX-006). The inbox
// itself, delivery by delivery, is tested in the api (services/api/test/inbox).
import { ChargePaymentV1 } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestPsp } from '../doubles/test-psp';
import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { failInsertsInto } from '../helpers/failing-inserts';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

const COMMANDS_QUEUE = 'payments.commands';
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

const recorded = (messageId: string) =>
  testDb().inboxMessage.findMany({ where: { messageId }, select: { consumer: true } });

describe('the record of a command is part of the transaction that settles it (IBX-002)', () => {
  it('records the command with the settled payment and its answer', async () => {
    const orderId = uuidv7();
    const command = chargeCommand(orderId);

    await broker.send(command);
    await broker.waitForEvents(orderId, 1);

    expect(await payment(orderId)).toEqual({ status: 'SUCCEEDED' });
    expect(await recorded(command.messageId)).toEqual([{ consumer: COMMANDS_QUEUE }]);
  });

  it('a record that cannot be written settles nothing and answers nothing: the next delivery does all three', async () => {
    const orderId = uuidv7();
    const command = chargeCommand(orderId);
    const restore = await failInsertsInto('inbox');
    try {
      await broker.send(command);
      // charged at the provider, and the transaction that would record it failed
      await waitFor(
        () => Promise.resolve(psp.calls(orderId).length),
        (calls) => calls >= 1,
        { what: 'the first call to the PSP' },
      );

      expect(await payment(orderId)).toEqual({ status: 'PENDING' });
      expect(await recorded(command.messageId)).toEqual([]);
      expect(broker.events(orderId)).toEqual([]);
    } finally {
      await restore();
    }

    // the command comes again after the delay: the provider answers the same, by its key
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({ name: 'payments.payment-succeeded' });
    expect(await payment(orderId)).toEqual({ status: 'SUCCEEDED' });
    expect(psp.charges(orderId)).toHaveLength(1);
    expect(await recorded(command.messageId)).toEqual([{ consumer: COMMANDS_QUEUE }]);
    expect(broker.events(orderId)).toHaveLength(1);
  });
});

describe('retention (IBX-005)', () => {
  it('a process that starts deletes the records older than the retention, and only those', async () => {
    const now = Date.now();
    const [old, recent] = [uuidv7(), uuidv7()];
    await testDb().inboxMessage.createMany({
      data: [
        { consumer: COMMANDS_QUEUE, messageId: old, processedAt: new Date(now - 8 * DAY_MS) },
        { consumer: COMMANDS_QUEUE, messageId: recent, processedAt: new Date(now - 6 * DAY_MS) },
      ],
    });

    const second = await createWorkerApp(psp);
    try {
      await waitFor(
        () => recorded(old),
        (rows) => rows.length === 0,
        { what: 'the old record to be deleted' },
      );

      expect(await recorded(recent)).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});
