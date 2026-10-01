// The payment path across processes (PAY-001…012): HTTP place → commit → handler enqueues
// `charge-order` → BullMQ on the Redis container → OrdersConsumer in the WORKER app →
// TestPsp → PAID / PAYMENT_FAILED. The API answers 202 before any of that, so the test does
// what a client does: polls GET /orders/{id}. Every assertion is on an outcome (row, history,
// charges at the PSP, state of the job), never on "a method was called".
import { getQueueToken } from '@nestjs/bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ORDERS_QUEUE } from '@modules/orders';

import { TestPsp } from '../doubles/test-psp';
import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { orderPath } from '../helpers/paths';
import { waitForJob, waitForStatus } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { USER_ACME_MEMBER, USER_GLOBEX_MEMBER, WS_ACME, WS_GLOBEX } from '../seed/ids';
import { testDb } from '../setup/db';

import type { Queue } from 'bullmq';

const psp = new TestPsp();
let api: ApiApp;
let worker: WorkerApp;
let queue: Queue;

beforeAll(async () => {
  api = await createApiApp();
  worker = await createWorkerApp(psp);
  queue = api.get<Queue>(getQueueToken(ORDERS_QUEUE));
});
// the API app holds a Prisma pool and Redis: it closes even when closing the worker fails
afterAll(async () => {
  try {
    await worker.close();
  } finally {
    await api.close();
  }
});

const member = asUser(USER_ACME_MEMBER);
const FINAL = ['PAID', 'PAYMENT_FAILED'] as const;
const jobIdOf = (orderId: string, attempt: number) => `charge-${orderId}-${String(attempt)}`;

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

describe('place → the worker charges → PAID (PAY-001, PAY-003, PAY-004)', () => {
  it('enqueues charge-<id>-1, charges the total once with key <id>:1 and records the success', async () => {
    const { id } = await orderFactory.create();

    await place(id);
    const order = await settle(id);

    // the job, as the handler enqueued it after the commit
    const { state, job } = await waitForJob(queue, jobIdOf(id, 1));
    expect(state).toBe('completed');
    expect(job.name).toBe('charge-order');
    expect(job.data).toEqual({ workspaceId: WS_ACME, orderId: id, paymentAttempt: 1 });

    // what the PSP was asked for
    const [call] = psp.calls(id);
    expect(psp.calls(id)).toHaveLength(1);
    expect(call?.reference).toBe(id);
    expect(call?.idempotencyKey).toBe(`${id}:1`);
    expect({
      amountMinor: Number(call?.amount.amountMinor),
      currency: call?.amount.currency,
    }).toEqual((order.totals as { total: unknown }).total);

    // the outcome
    expect(order).toMatchObject({ status: 'PAID', pspChargeId: `ch_${id}:1`, version: 2 });
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
      payload: { paymentAttempt: 1, pspChargeId: `ch_${id}:1` },
    });
  });

  it('binds the tenant from the job: a globex order is charged in USD in globex (PAY-012)', async () => {
    const globexMember = asUser(USER_GLOBEX_MEMBER);
    const { id } = await orderFactory.create({ workspaceId: WS_GLOBEX });

    await place(id, 0, WS_GLOBEX, globexMember);
    const order = await settle(id, WS_GLOBEX, globexMember);

    expect(order.status).toBe('PAID');
    expect(psp.calls(id)[0]?.amount.currency).toBe('USD');
    expect((await waitForJob(queue, jobIdOf(id, 1))).job.data).toMatchObject({
      workspaceId: WS_GLOBEX,
    });
  });
});

describe('a charge is never made twice (PAY-002, PAY-009, PAY-010)', () => {
  it('layer 1 — the same job id is not enqueued again', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    await settle(id);
    const jobId = jobIdOf(id, 1);
    const first = await waitForJob(queue, jobId);

    const again = await queue.add('charge-order', first.job.data, { jobId });

    expect(again.id).toBe(jobId);
    expect(await again.getState()).toBe('completed'); // the existing job, not a new one
    // by name: the cron scheduler always keeps its next tick in the queue as a delayed job
    const pending = await queue.getJobs(['waiting', 'active', 'delayed']);
    expect(pending.filter((job) => job.name === 'charge-order')).toEqual([]);
    expect(psp.calls(id)).toHaveLength(1);
  });

  it('layers 2–3 — a redelivered job (another id, same data) changes nothing and charges nothing', async () => {
    const { id } = await orderFactory.create();
    await place(id);
    await settle(id);
    const before = await stored(id);
    const data = (await waitForJob(queue, jobIdOf(id, 1))).job.data as object;

    await queue.add('charge-order', data, { jobId: `redelivery-${id}` });
    const replay = await waitForJob(queue, `redelivery-${id}`);

    expect(replay.state).toBe('completed'); // "already done", not a failure
    expect(psp.calls(id)).toHaveLength(1); // the order is PAID: stopped before the PSP
    expect(psp.charges(id)).toHaveLength(1);
    expect(await stored(id)).toEqual(before);
  });
});

describe('two workers in the same charge at once (PAY-010, layer 3)', () => {
  let second: WorkerApp;
  beforeAll(async () => {
    second = await createWorkerApp(psp); // a second worker process, same Redis and database
  });
  afterAll(() => second.close());

  it('both reach the PSP with the same idempotency key → one charge, one PAID, both jobs done', async () => {
    const { id } = await orderFactory.create();
    psp.holdUntilConcurrent(id, 2);

    await place(id);
    const data = { workspaceId: WS_ACME, orderId: id, paymentAttempt: 1 };
    await queue.add('charge-order', data, { jobId: `race-${id}` }); // a duplicate delivery
    const order = await settle(id);
    const jobs = [await waitForJob(queue, jobIdOf(id, 1)), await waitForJob(queue, `race-${id}`)];

    expect(psp.calls(id)).toHaveLength(2); // both passed "is it still pending?"
    expect(psp.charges(id)).toHaveLength(1); // …and the key made it one charge
    expect(order.status).toBe('PAID');
    expect((await stored(id)).history.filter((t) => t === 'PAYMENT_SUCCEEDED')).toHaveLength(1);
    expect(jobs.map((j) => j.state)).toEqual(['completed', 'completed']);
  });
});

describe('PSP failures (PAY-005…008)', () => {
  // the defaults (5 attempts, 1 s) are pinned in env.schema.spec.ts; here: the queue uses them
  it('retries a charge with exponential backoff, attempts and base delay from config (PAY-006)', () => {
    expect(queue.defaultJobOptions).toMatchObject({
      attempts: 3, // CHARGE_ATTEMPTS in .env.test
      backoff: { type: 'exponential', delay: 10 }, // CHARGE_BACKOFF_MS in .env.test
    });
  });

  it('retries transient failures: 503, 503, then 200 on the last attempt → PAID (PAY-006)', async () => {
    const { id } = await orderFactory.create();
    psp.script(id, 'unavailable', 'unavailable', 'ok');

    await place(id);
    const order = await settle(id);
    const job = await waitForJob(queue, jobIdOf(id, 1));

    expect(order.status).toBe('PAID');
    expect(psp.calls(id)).toHaveLength(3); // CHARGE_ATTEMPTS=3: the success is exactly the last try
    expect(psp.charges(id)).toHaveLength(1);
    expect(job.state).toBe('completed');
  });

  it('does not retry a decline: PAYMENT_FAILED with the decline code (PAY-005)', async () => {
    const { id } = await orderFactory.create();
    psp.script(id, 'declined:insufficient_funds');

    await place(id);
    const order = await settle(id);
    const job = await waitForJob(queue, jobIdOf(id, 1));

    expect(order).toMatchObject({ status: 'PAYMENT_FAILED', failureReason: 'insufficient_funds' });
    expect(psp.calls(id)).toHaveLength(1);
    expect(job.state).toBe('completed');
    const { body } = await api
      .http()
      .get(`${orderPath(WS_ACME, id)}/events`)
      .set(member)
      .expect(200);
    expect((body as { items: unknown[] }).items.at(-1)).toMatchObject({
      type: 'PAYMENT_FAILED',
      actor: 'system:consumer:orders',
      payload: { paymentAttempt: 1, reason: 'insufficient_funds' },
    });
  });

  it('gives up after the last transient failure: PAYMENT_FAILED psp_unavailable, job completed (PAY-007)', async () => {
    const { id } = await orderFactory.create();
    psp.script(id, 'unavailable', 'unavailable', 'unavailable');

    await place(id);
    const order = await settle(id);
    const job = await waitForJob(queue, jobIdOf(id, 1));

    expect(order).toMatchObject({ status: 'PAYMENT_FAILED', failureReason: 'psp_unavailable' });
    expect(psp.calls(id)).toHaveLength(3);
    expect(job.state).toBe('completed'); // not a dead job: the outcome was recorded
  });

  it('does not retry a non-transient failure: PAYMENT_FAILED psp_rejected (PAY-008)', async () => {
    const { id } = await orderFactory.create();
    psp.script(id, 'rejected');

    await place(id);
    const order = await settle(id);
    const job = await waitForJob(queue, jobIdOf(id, 1));

    expect(order).toMatchObject({ status: 'PAYMENT_FAILED', failureReason: 'psp_rejected' });
    expect(psp.calls(id)).toHaveLength(1);
    expect(job.state).toBe('completed');
  });
});

describe('a new attempt after a failure (PAY-009, PAY-011)', () => {
  it('charges attempt 2 with its own key; a late job of attempt 1 then does nothing', async () => {
    const { id } = await orderFactory.create();
    psp.script(id, 'declined:card_declined');
    await place(id);
    expect((await settle(id)).status).toBe('PAYMENT_FAILED');

    await place(id, 2); // place → 1, payment failed → 2
    const order = await settle(id);

    expect(order).toMatchObject({ status: 'PAID', paymentAttempt: 2, failureReason: null });
    expect(psp.calls(id).map((c) => c.idempotencyKey)).toEqual([`${id}:1`, `${id}:2`]);

    // a stale job of attempt 1 arrives late
    const before = await stored(id);
    await queue.add(
      'charge-order',
      { workspaceId: WS_ACME, orderId: id, paymentAttempt: 1 },
      {
        jobId: `late-${id}`,
      },
    );
    const late = await waitForJob(queue, `late-${id}`);

    expect(late.state).toBe('completed');
    expect(psp.calls(id)).toHaveLength(2);
    expect(await stored(id)).toEqual(before);
  });
});
