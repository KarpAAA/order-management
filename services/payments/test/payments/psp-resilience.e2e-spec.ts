// The service with its real HTTP gateway, against a provider that fails (MSW answers the
// gateway's fetch in this process). The other files of the suite put TestPsp on the port and
// say what the use case does with "the provider is away"; this one says when the gateway
// comes to that conclusion, and what it costs: calls at the provider, deliveries of the
// command (docs/adr/0020). `.env.test`: the third delivery is the last, 200 ms apart.
import { ChargePaymentV1 } from '@oms/contracts';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { createWorkerApp, httpGateway, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

const WORKSPACE = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02';
// where httpGateway() of the helpers sends its calls
const PSP_URL = 'http://psp.test';
const DEAD_LETTER_QUEUE = 'payments.commands.dlq';

/** The provider: what it answers from now on, and every call it got, by order. */
const psp = {
  down: false,
  failures: new Map<string, number>(),
  calls: [] as string[],
  callsOf(orderId: string): number {
    return this.calls.filter((reference) => reference === orderId).length;
  },
};
const server = setupServer(
  http.post(`${PSP_URL}/charges`, async ({ request }) => {
    const { reference } = (await request.json()) as { reference: string };
    psp.calls.push(reference);
    const failuresLeft = psp.failures.get(reference) ?? 0;
    if (psp.down || failuresLeft > 0) {
      psp.failures.set(reference, failuresLeft - 1);
      return HttpResponse.json({ error: 'temporarily unavailable' }, { status: 503 });
    }
    return HttpResponse.json({ id: `ch_${reference}`, status: 'succeeded' }, { status: 201 });
  }),
);

let broker: TestBroker;

beforeAll(async () => {
  // the broker and the database are reached over sockets, not fetch: let everything else by
  server.listen({ onUnhandledRequest: 'bypass' });
  broker = await connectTestBroker();
});
afterEach(() => {
  psp.down = false;
});
afterAll(async () => {
  await broker.close();
  server.close();
});

function chargeCommand(orderId: string): ChargePaymentV1 {
  return ChargePaymentV1.create(
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
}

const row = (orderId: string) => testDb().payment.findFirstOrThrow({ where: { orderId } });

describe('a provider that hiccups is asked again within the delivery (PAY-027)', () => {
  let service: WorkerApp;
  beforeAll(async () => {
    service = await createWorkerApp(httpGateway({ pspMaxRetries: 4 }));
  });
  afterAll(() => service.close());

  it('charges on the fifth call: more calls than the command has deliveries', async () => {
    const orderId = uuidv7();
    psp.failures.set(orderId, 4);

    await broker.send(chargeCommand(orderId));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'payments.payment-succeeded',
      payload: { orderId, chargeId: `ch_${orderId}` },
    });
    // three deliveries of one call each would have ended as psp_unavailable
    expect(psp.callsOf(orderId)).toBe(5);
    expect(await row(orderId)).toMatchObject({ status: 'SUCCEEDED' });
  });
});

describe('a provider that is down is not called (PAY-030, PAY-031)', () => {
  // open on the second failed call, and stay open for the rest of the block but the last test
  const HALF_OPEN_MS = 3000;
  let service: WorkerApp;
  let openedAt = 0;
  beforeAll(async () => {
    service = await createWorkerApp(
      httpGateway({ pspBreakerMinCalls: 2, pspBreakerHalfOpenMs: HALF_OPEN_MS }),
    );
  });
  afterAll(() => service.close());

  it('stops calling after the second failure, and the last delivery answers psp_unavailable', async () => {
    const orderId = uuidv7();
    psp.down = true;

    await broker.send(chargeCommand(orderId));
    const [event] = await broker.waitForEvents(orderId);
    openedAt = performance.now();

    expect(event).toMatchObject({
      name: 'payments.payment-failed',
      payload: { orderId, declineCode: 'psp_unavailable', chargeId: null },
    });
    // three deliveries, two calls: the third found the circuit open
    expect(psp.callsOf(orderId)).toBe(2);
    expect(await row(orderId)).toMatchObject({ status: 'FAILED', failureCode: 'psp_unavailable' });
  });

  it('answers a command that arrives meanwhile without a single call', async () => {
    const orderId = uuidv7();
    psp.down = true;

    await broker.send(chargeCommand(orderId));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'payments.payment-failed',
      payload: { orderId, declineCode: 'psp_unavailable' },
    });
    expect(psp.callsOf(orderId)).toBe(0);
    // every delivery was spent, and the command was answered, not given up
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
  });

  it('calls again once the provider is back and the circuit has waited', async () => {
    const orderId = uuidv7();
    const waited = performance.now() - openedAt;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, HALF_OPEN_MS - waited) + 100));

    await broker.send(chargeCommand(orderId));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({ name: 'payments.payment-succeeded', payload: { orderId } });
    expect(psp.callsOf(orderId)).toBe(1);
  });
});
