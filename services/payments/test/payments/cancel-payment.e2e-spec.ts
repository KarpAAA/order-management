// A payment attempt that is taken back (PAY-020…026): `payments.cancel-payment` goes in through
// RabbitMQ next to `payments.charge-payment`, and what comes out is the row of the attempt
// and the answers on the `events` exchange. The provider is TestPsp, which can keep a charge
// in flight while the test sends the cancellation. Every assertion is on an outcome (row,
// event, charges and voids at the PSP).
import { CancelPaymentV1, ChargePaymentV1 } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestPsp } from '../doubles/test-psp';
import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

const COMMANDS_QUEUE = 'payments.commands';
const DEAD_LETTER_QUEUE = 'payments.commands.dlq';
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

const meta = (correlationId = uuidv7()) => ({
  messageId: uuidv7(),
  occurredAt: new Date(),
  workspaceId: WORKSPACE,
  correlationId,
});

const chargeCommand = (orderId: string, expiresAt?: Date, correlationId?: string) =>
  ChargePaymentV1.create(meta(correlationId), {
    orderId,
    paymentAttempt: 1,
    amount: { amountMinor: 12_50, currency: 'EUR' },
    idempotencyKey: `${orderId}:1`,
    ...(expiresAt && { expiresAt: expiresAt.toISOString() }),
  });

const cancelCommand = (orderId: string, correlationId?: string) =>
  CancelPaymentV1.create(meta(correlationId), { orderId, paymentAttempt: 1 });

const rows = (orderId: string) => testDb().payment.findMany({ where: { orderId } });
const names = (orderId: string) => broker.events(orderId).map((event) => event.name);

/**
 * Proof that every command sent before this call has been handled: the service takes one
 * message at a time (RABBITMQ_PREFETCH=1), so a command sent after them is behind them in
 * the queue, and its answer comes after theirs.
 */
async function handled(): Promise<void> {
  const marker = uuidv7();
  await broker.send(chargeCommand(marker));
  await broker.waitForEvents(marker, 1);
}

const inFlight = (orderId: string) =>
  waitFor(
    () => psp.calls(orderId).length,
    (calls) => calls >= 1,
    { what: 'the charge to reach the PSP' },
  );

describe('an attempt that is not charged yet is cancelled (PAY-020, PAY-021)', () => {
  it('cancels a PENDING attempt, and the charge that comes again charges nothing (PAY-020)', async () => {
    const orderId = uuidv7();
    const charge = chargeCommand(orderId);
    psp.script(orderId, 'unavailable');

    // the first delivery leaves the row PENDING; the cancellation is behind it in the queue
    await broker.send(charge);
    await broker.send(cancelCommand(orderId));
    const [first] = await broker.waitForEvents(orderId, 1);

    expect(first).toMatchObject({
      name: 'payments.payment-cancelled',
      version: 1,
      workspaceId: WORKSPACE,
      // of the row, so of the command that asked for the charge
      correlationId: charge.correlationId,
      payload: { orderId, paymentAttempt: 1 },
    });

    // the charge returns from its wait queue and finds the attempt ended
    await broker.waitForEvents(orderId, 2);
    await handled();

    expect(names(orderId)).toEqual(['payments.payment-cancelled', 'payments.payment-cancelled']);
    expect(psp.calls(orderId)).toHaveLength(1);
    expect(psp.charges(orderId)).toEqual([]);
    expect(psp.voids(orderId)).toEqual([]);
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({
        status: 'CANCELLED',
        settledAt: expect.any(Date),
        pspChargeId: null,
        failureCode: null,
        voidedAt: null,
      }),
    ]);
  });

  it('remembers a cancellation that came before its charge command (PAY-021)', async () => {
    const orderId = uuidv7();
    const cancel = cancelCommand(orderId);

    await broker.send(cancel);
    const [first] = await broker.waitForEvents(orderId, 1);

    expect(first).toMatchObject({
      name: 'payments.payment-cancelled',
      correlationId: cancel.correlationId,
    });
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        attempt: 1,
        status: 'CANCELLED',
        amountMinor: null,
        currency: null,
        idempotencyKey: null,
        settledAt: expect.any(Date),
      }),
    ]);

    await broker.send(chargeCommand(orderId));
    await broker.waitForEvents(orderId, 2);

    expect(names(orderId)).toEqual(['payments.payment-cancelled', 'payments.payment-cancelled']);
    expect(psp.calls(orderId)).toEqual([]);
    expect(await rows(orderId)).toHaveLength(1);
  });
});

describe('an attempt that has ended is not cancelled (PAY-022)', () => {
  it.each([
    { outcome: 'ok' as const, status: 'SUCCEEDED', answer: 'payments.payment-succeeded' },
    {
      outcome: 'declined:card_declined' as const,
      status: 'FAILED',
      answer: 'payments.payment-failed',
    },
  ])('answers a $status attempt with $answer again', async ({ outcome, status, answer }) => {
    const orderId = uuidv7();
    psp.script(orderId, outcome);

    await broker.send(chargeCommand(orderId));
    await broker.waitForEvents(orderId, 1);
    await broker.send(cancelCommand(orderId));
    const events = await broker.waitForEvents(orderId, 2);

    expect(events.map((event) => event.name)).toEqual([answer, answer]);
    expect(events[1]?.payload).toEqual(events[0]?.payload);
    expect(await rows(orderId)).toEqual([expect.objectContaining({ status, voidedAt: null })]);
    expect(psp.voids(orderId)).toEqual([]);
  });
});

describe('a cancellation while the provider is charging (PAY-023, PAY-024)', () => {
  let second: WorkerApp;
  beforeAll(async () => {
    // a second process: it takes the cancellation while the first is inside the PSP call
    second = await createWorkerApp(psp);
  });
  afterAll(() => second.close());

  it('answers "cancelled" and takes back the charge the provider made (PAY-023)', async () => {
    const orderId = uuidv7();
    const release = psp.hold(orderId);

    await broker.send(chargeCommand(orderId));
    await inFlight(orderId);
    await broker.send(cancelCommand(orderId));
    await broker.waitForEvents(orderId, 1);

    // answered at once: the sender does not wait for the provider
    expect(names(orderId)).toEqual(['payments.payment-cancelled']);
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({ status: 'CANCELLED', pspChargeId: null }),
    ]);

    release();
    await waitFor(
      () => rows(orderId),
      ([row]) => row?.voidedAt != null,
      { what: 'the charge to be voided' },
    );

    expect(psp.charges(orderId)).toEqual([{ status: 'succeeded', chargeId: `ch_${orderId}:1` }]);
    expect(psp.voids(orderId)).toEqual([`ch_${orderId}:1`]);
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({
        status: 'CANCELLED',
        pspChargeId: `ch_${orderId}:1`,
        voidedAt: expect.any(Date),
      }),
    ]);
    // the charge command is answered as well, and never with a success
    await broker.waitForEvents(orderId, 2);
    expect(names(orderId)).toEqual(['payments.payment-cancelled', 'payments.payment-cancelled']);
  });

  it('does not void a decline: no money moved (PAY-023)', async () => {
    const orderId = uuidv7();
    psp.script(orderId, 'declined:card_declined');
    const release = psp.hold(orderId);

    await broker.send(chargeCommand(orderId));
    await inFlight(orderId);
    await broker.send(cancelCommand(orderId));
    await broker.waitForEvents(orderId, 1);
    release();
    await broker.waitForEvents(orderId, 2);

    expect(names(orderId)).toEqual(['payments.payment-cancelled', 'payments.payment-cancelled']);
    expect(psp.voids(orderId)).toEqual([]);
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({ status: 'CANCELLED', pspChargeId: null, voidedAt: null }),
    ]);
  });

  it('voids again when the first void did not get through (PAY-024)', async () => {
    const orderId = uuidv7();
    const release = psp.hold(orderId);
    psp.failVoids(1);

    await broker.send(chargeCommand(orderId));
    await inFlight(orderId);
    await broker.send(cancelCommand(orderId));
    await broker.waitForEvents(orderId, 1);
    release();
    await waitFor(
      () => rows(orderId),
      ([row]) => row?.voidedAt != null,
      { what: 'the charge to be voided on the next delivery' },
    );

    // the same charge id both times: the second delivery read it from the row
    expect(psp.voids(orderId)).toEqual([`ch_${orderId}:1`, `ch_${orderId}:1`]);
    expect(psp.charges(orderId)).toHaveLength(1);
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
    // answered once by the delivery that settled; the next one found the message recorded
    expect(names(orderId)).toEqual(['payments.payment-cancelled', 'payments.payment-cancelled']);
  });
});

describe('a charge command that is handled too late (PAY-025)', () => {
  it('charges nothing after its expiry and ends the attempt as expired', async () => {
    const orderId = uuidv7();

    await broker.send(chargeCommand(orderId, new Date(Date.now() - 1000)));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'payments.payment-failed',
      payload: { orderId, paymentAttempt: 1, declineCode: 'expired', chargeId: null },
    });
    expect(psp.calls(orderId)).toEqual([]);
    expect(await rows(orderId)).toEqual([
      expect.objectContaining({ status: 'FAILED', failureCode: 'expired', pspChargeId: null }),
    ]);
  });

  it('expires on the delivery after the moment: a provider that was away is not asked again', async () => {
    const orderId = uuidv7();
    psp.script(orderId, 'unavailable', 'ok');

    // .env.test: the next delivery is 200 ms away, past the expiry
    await broker.send(chargeCommand(orderId, new Date(Date.now() + 100)));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'payments.payment-failed',
      payload: { declineCode: 'expired' },
    });
    expect(psp.calls(orderId)).toHaveLength(1);
    expect(psp.charges(orderId)).toEqual([]);
  });

  it('charges a command whose expiry is still ahead', async () => {
    const orderId = uuidv7();

    await broker.send(chargeCommand(orderId, new Date(Date.now() + 60_000)));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({ name: 'payments.payment-succeeded' });
  });
});

describe('a cancellation delivered again (PAY-026)', () => {
  it('answers the same message once and records it', async () => {
    const orderId = uuidv7();
    const cancel = cancelCommand(orderId);

    for (let delivery = 0; delivery < 5; delivery += 1) await broker.send(cancel);
    await broker.waitForEvents(orderId, 1);
    await handled();

    expect(names(orderId)).toEqual(['payments.payment-cancelled']);
    expect(await rows(orderId)).toHaveLength(1);
    expect(
      await testDb().inboxMessage.findMany({ where: { messageId: cancel.messageId } }),
    ).toEqual([expect.objectContaining({ consumer: COMMANDS_QUEUE })]);
  });

  it('answers another cancellation of the attempt from the row', async () => {
    const orderId = uuidv7();

    await broker.send(cancelCommand(orderId));
    await broker.send(cancelCommand(orderId));
    const events = await broker.waitForEvents(orderId, 2);

    expect(events.map((event) => event.name)).toEqual([
      'payments.payment-cancelled',
      'payments.payment-cancelled',
    ]);
    expect(new Set(events.map((event) => event.messageId)).size).toBe(2);
    expect(await rows(orderId)).toHaveLength(1);
  });
});
