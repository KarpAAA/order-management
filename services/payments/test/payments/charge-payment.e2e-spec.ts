// The service to its boundary: a `payments.charge-payment` command goes in through RabbitMQ,
// the consumer charges at TestPsp, and what comes out is a row in the service's own database
// and one event on the `events` exchange. The api is not here: the test is the other side of
// the broker (test/helpers/broker.ts). Every assertion is on an outcome (row, event, charges
// at the PSP), never on "a method was called".
import { ChargePaymentV1 } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONNECTION_NAME } from '@infra/messaging/rabbit-connection';

import { TestPsp } from '../doubles/test-psp';
import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

// the queues the service declares for itself: names on the wire, so the test spells them out
const COMMANDS_QUEUE = 'payments.commands';
const DEAD_LETTER_QUEUE = 'payments.commands.dlq';
// .env.test: the third delivery of a command is the last, 200 ms after the one before
const MAX_ATTEMPTS = 3;
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

    expect(events).toMatchObject([
      { name: 'payments.payment-failed', payload: { paymentAttempt: 1 } },
      { name: 'payments.payment-succeeded', payload: { paymentAttempt: 2 } },
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
    // one call: the provider answered, and asking again would get the same answer
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
});

describe('a provider that does not answer: the command is delivered again (PAY-006, PAY-007)', () => {
  it('charges on the delivery the provider is back for, and answers once (PAY-006)', async () => {
    const orderId = uuidv7();
    psp.script(orderId, 'unavailable', 'unavailable');

    await broker.send(chargeCommand({ orderId }));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'payments.payment-succeeded',
      payload: { orderId, paymentAttempt: 1, chargeId: `ch_${orderId}:1` },
    });
    // three deliveries of one command: the same key each time
    expect(psp.calls(orderId).map((call) => call.idempotencyKey)).toEqual(
      Array(MAX_ATTEMPTS).fill(`${orderId}:1`),
    );
    expect(await rows(orderId)).toEqual([expect.objectContaining({ status: 'SUCCEEDED' })]);
    // no answer was given while the outcome was open, and nothing was given up
    expect(broker.events(orderId)).toHaveLength(1);
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
  });

  it('leaves the payment PENDING between deliveries', async () => {
    const orderId = uuidv7();
    psp.script(orderId, 'unavailable');

    await broker.send(chargeCommand({ orderId }));
    await waitFor(
      () => psp.calls(orderId).length,
      (calls) => calls === 1,
      { what: 'the first call to the PSP' },
    );

    expect(await rows(orderId)).toEqual([
      expect.objectContaining({ status: 'PENDING', settledAt: null }),
    ]);
    expect(broker.events(orderId)).toEqual([]);
    await broker.waitForEvents(orderId); // the second delivery settles it
  });

  it('ends the attempt as psp_unavailable on the last delivery (PAY-007)', async () => {
    const orderId = uuidv7();
    psp.script(orderId, ...Array<'unavailable'>(MAX_ATTEMPTS).fill('unavailable'));

    await broker.send(chargeCommand({ orderId }));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'payments.payment-failed',
      payload: { orderId, paymentAttempt: 1, declineCode: 'psp_unavailable', chargeId: null },
    });
    expect(psp.calls(orderId)).toHaveLength(MAX_ATTEMPTS);
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({ status: 'FAILED', failureCode: 'psp_unavailable' }),
    ]);
    // answered, not given up: the api has its outcome
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
  });
});

describe('a command that fails on every delivery is parked (PAY-016, PAY-017)', () => {
  it('lands in the dead-letter queue after the last delivery, and is charged when put back', async () => {
    const orderId = uuidv7();
    const command = chargeCommand({ orderId });
    psp.script(orderId, ...Array<'broken'>(MAX_ATTEMPTS).fill('broken'));

    await broker.send(command);
    const [parked] = await waitFor(
      () => broker.take(DEAD_LETTER_QUEUE),
      (taken) => taken.length > 0,
      { what: 'the command in the dead-letter queue' },
    );

    // the message as it was sent, with where it came from and why it was given up
    expect(JSON.parse(parked?.content.toString() ?? '')).toMatchObject({
      messageId: command.messageId,
    });
    expect(parked?.headers).toMatchObject({
      'x-parked-from': COMMANDS_QUEUE,
      'x-last-error': 'TypeError: cannot read the charge',
    });
    expect(psp.calls(orderId)).toHaveLength(MAX_ATTEMPTS);
    // nothing was answered: the payment is still open
    expect(broker.events(orderId)).toEqual([]);
    expect(await rows(orderId)).toEqual([expect.objectContaining({ status: 'PENDING' })]);

    // the operator fixed the cause and moves the message back
    if (parked) broker.put(COMMANDS_QUEUE, parked.content, parked.headers);
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({ name: 'payments.payment-succeeded' });
    expect(await rows(orderId)).toEqual([expect.objectContaining({ status: 'SUCCEEDED' })]);
  });
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

describe('a message that is not a known command is parked at once, and the service goes on (PAY-015)', () => {
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
    // kept as it came, for whoever has to find out who sent it
    const parked = await broker.take(DEAD_LETTER_QUEUE);
    expect(parked.map((message) => message.content)).toEqual([content]);
    expect(parked[0]?.headers).toMatchObject({
      'x-parked-from': COMMANDS_QUEUE,
      'x-last-error': expect.stringMatching(/^UnprocessableMessageError: /),
    });
  });
});

describe('the consumer dies in the middle of a command (PAY-018)', () => {
  it('gets the command again: one charge, one settled payment', async () => {
    const orderId = uuidv7();
    // the first delivery waits inside the PSP call until the second one arrives (or 5 s pass)
    psp.holdUntilConcurrent(orderId, 2);

    await broker.send(chargeCommand({ orderId }));
    await waitFor(
      () => psp.calls(orderId).length,
      (calls) => calls === 1,
      { what: 'the command to reach the PSP' },
    );
    // what the broker sees when the process is killed: the connection is gone, nothing was
    // acknowledged. The service reconnects, as a restarted process would.
    await broker.killConnection(CONNECTION_NAME);

    // both deliveries answer: the interrupted one when its call returns, the second as well
    const events = await broker.waitForEvents(orderId, 2);

    expect(events.map((event) => event.name)).toEqual([
      'payments.payment-succeeded',
      'payments.payment-succeeded',
    ]);
    expect(psp.charges(orderId)).toHaveLength(1);
    expect(await rows(orderId)).toEqual([expect.objectContaining({ status: 'SUCCEEDED' })]);
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
  }, 60_000);
});
