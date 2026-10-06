// The service to its boundary: a `payments.charge-payment` command goes in through RabbitMQ,
// the consumer charges at TestPsp, and what comes out is a row in the service's own database
// and one event on the `events` exchange. The api is not here: the test is the other side of
// the broker (test/helpers/broker.ts). Every assertion is on an outcome (row, event, charges
// at the PSP), never on "a method was called".
import { ChargePaymentV1 } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestPsp } from '../doubles/test-psp';
import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

// the queue the service declares for itself: a name on the wire, so the test spells it out
const COMMANDS_QUEUE = 'payments.commands';
const WORKSPACE = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02';

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

interface Charge {
  orderId: string;
  attempt?: number;
  amountMinor?: number;
  currency?: string;
  correlationId?: string;
}

function chargeCommand({
  orderId,
  attempt = 1,
  amountMinor = 12_50,
  currency = 'EUR',
  correlationId = uuidv7(),
}: Charge): ChargePaymentV1 {
  return ChargePaymentV1.create(
    { messageId: uuidv7(), occurredAt: new Date(), workspaceId: WORKSPACE, correlationId },
    {
      orderId,
      paymentAttempt: attempt,
      amount: { amountMinor, currency },
      idempotencyKey: `${orderId}:${String(attempt)}`,
    },
  );
}

const rows = (orderId: string) =>
  testDb().payment.findMany({ where: { orderId }, orderBy: { attempt: 'asc' } });

describe('a command is charged and answered (PAY-003, PAY-004)', () => {
  it('charges the amount once with the key of the command and publishes payment-succeeded', async () => {
    const orderId = uuidv7();
    const command = chargeCommand({ orderId, amountMinor: 99_90, currency: 'USD' });

    await broker.send(command);
    const [event] = await broker.waitForEvents(orderId);

    // what the PSP was asked for
    expect(psp.calls(orderId)).toEqual([
      {
        amount: { amountMinor: 9990n, currency: 'USD' },
        reference: orderId,
        idempotencyKey: `${orderId}:1`,
      },
    ]);

    // the answer: the same tenant and correlation id as the command, a message id of its own
    expect(event).toMatchObject({
      name: 'payments.payment-succeeded',
      version: 1,
      workspaceId: WORKSPACE,
      correlationId: command.correlationId,
      payload: { orderId, paymentAttempt: 1, chargeId: `ch_${orderId}:1` },
    });
    expect(event?.messageId).not.toBe(command.messageId);

    // the row in the service's own database
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        attempt: 1,
        amountMinor: 9990n,
        currency: 'USD',
        status: 'SUCCEEDED',
        pspChargeId: `ch_${orderId}:1`,
        failureCode: null,
        settledAt: expect.any(Date),
      }),
    ]);
  });

  it('charges a new attempt of the same order as a payment of its own (PAY-011)', async () => {
    const orderId = uuidv7();
    psp.script(orderId, 'declined:card_declined');

    await broker.send(chargeCommand({ orderId, attempt: 1 }));
    await broker.waitForEvents(orderId, 1);
    await broker.send(chargeCommand({ orderId, attempt: 2 }));
    const events = await broker.waitForEvents(orderId, 2);

    expect(events.map((e) => [e.name, e.payload.paymentAttempt])).toEqual([
      ['payments.payment-failed', 1],
      ['payments.payment-succeeded', 2],
    ]);
    expect(psp.calls(orderId).map((c) => c.idempotencyKey)).toEqual([
      `${orderId}:1`,
      `${orderId}:2`,
    ]);
    expect((await rows(orderId)).map((r) => r.status)).toEqual(['FAILED', 'SUCCEEDED']);
  });
});

describe('a charge that does not succeed is answered with payment-failed (PAY-005…008)', () => {
  it.each([
    {
      name: 'a decline keeps the decline code and the charge id (PAY-005)',
      outcome: 'declined:insufficient_funds' as const,
      declineCode: 'insufficient_funds',
      hasCharge: true,
    },
    {
      name: 'a provider that does not answer ends the attempt as psp_unavailable (PAY-007)',
      outcome: 'unavailable' as const,
      declineCode: 'psp_unavailable',
      hasCharge: false,
    },
    {
      name: 'a provider that refuses the request ends the attempt as psp_rejected (PAY-008)',
      outcome: 'rejected' as const,
      declineCode: 'psp_rejected',
      hasCharge: false,
    },
  ])('$name', async ({ outcome, declineCode, hasCharge }) => {
    const orderId = uuidv7();
    const chargeId = hasCharge ? `ch_${orderId}:1` : null;
    psp.script(orderId, outcome);

    await broker.send(chargeCommand({ orderId }));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'payments.payment-failed',
      payload: { orderId, paymentAttempt: 1, declineCode, chargeId },
    });
    // one call: nothing retries yet, whatever the failure
    expect(psp.calls(orderId)).toHaveLength(1);
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({
        status: 'FAILED',
        failureCode: declineCode,
        pspChargeId: chargeId,
        settledAt: expect.any(Date),
      }),
    ]);
  });

  // ROADMAP 3.3 (the command is redelivered with a delay) and 3.11 (the call is retried):
  it.todo('retries a transient failure before it gives up (PAY-006)');
});

describe('a command delivered twice charges once (PAY-009, PAY-010)', () => {
  it('answers the second delivery with the stored outcome and does not call the PSP again', async () => {
    const orderId = uuidv7();
    const command = chargeCommand({ orderId });

    await broker.send(command);
    await broker.waitForEvents(orderId, 1);
    await broker.send(command);
    const events = await broker.waitForEvents(orderId, 2);

    // the answer is given again: the first one may never have reached its reader
    expect(events.map((e) => e.payload)).toEqual([events[0]?.payload, events[0]?.payload]);
    expect(psp.calls(orderId)).toHaveLength(1);
    expect(await rows(orderId)).toHaveLength(1);
  });

  it('keeps the first amount: a repeated attempt with other content changes nothing', async () => {
    const orderId = uuidv7();

    await broker.send(chargeCommand({ orderId, amountMinor: 10_00 }));
    await broker.waitForEvents(orderId, 1);
    await broker.send(chargeCommand({ orderId, amountMinor: 99_00 }));
    await broker.waitForEvents(orderId, 2);

    expect(psp.calls(orderId)).toHaveLength(1);
    expect((await rows(orderId)).map((r) => r.amountMinor)).toEqual([1000n]);
  });
});

describe('two consumers in the same charge at once (PAY-010)', () => {
  let second: WorkerApp;
  beforeAll(async () => {
    second = await createWorkerApp(psp); // a second process, same database and queue
  });
  afterAll(() => second.close());

  it('both reach the PSP with the same key → one row, one charge, the same answer twice', async () => {
    const orderId = uuidv7();
    psp.holdUntilConcurrent(orderId, 2);
    const command = chargeCommand({ orderId });

    // prefetch is 1: the broker hands one delivery to each consumer
    await broker.send(command);
    await broker.send(command);
    const events = await broker.waitForEvents(orderId, 2);

    expect(psp.calls(orderId)).toHaveLength(2); // both found the row PENDING
    expect(psp.charges(orderId)).toHaveLength(1); // …and the key made it one charge
    expect(await rows(orderId)).toEqual([expect.objectContaining({ status: 'SUCCEEDED' })]);
    expect(events.map((e) => e.name)).toEqual([
      'payments.payment-succeeded',
      'payments.payment-succeeded',
    ]);
  });
});

describe('a message that is not a known command is rejected, and the service goes on', () => {
  const drained = () =>
    waitFor(
      () => broker.depth(COMMANDS_QUEUE),
      (depth) => depth === 0,
      { what: 'the commands queue to be empty' },
    );

  it.each([
    ['bytes that are not JSON', Buffer.from('not json')],
    ['JSON that is not a message', Buffer.from(JSON.stringify({ hello: 'world' }))],
    [
      'a version this build does not know',
      Buffer.from(JSON.stringify({ ...chargeCommand({ orderId: uuidv7() }), version: 2 })),
    ],
    [
      'a command that breaks its contract',
      Buffer.from(
        JSON.stringify({
          ...chargeCommand({ orderId: uuidv7() }),
          payload: { orderId: 'not-a-uuid' },
        }),
      ),
    ],
  ])('%s', async (_, content) => {
    const before = await testDb().payment.count();

    broker.sendRaw(ChargePaymentV1.name, content);
    // the next command is served: the bad one was not put back in front of it
    const orderId = uuidv7();
    await broker.send(chargeCommand({ orderId }));
    await broker.waitForEvents(orderId);
    await drained();

    expect(await testDb().payment.count()).toBe(before + 1);
  });
});
