// OrderSagasRepository against Postgres (SAGA-012, SAGA-015): the optimistic lock of save(),
// the tenant of a saga, and the constraints of the table that Prisma cannot express. The
// subject is the repository and its SQL, so the test drives it directly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConcurrencyError } from '@shared/errors/domain-error';

import { OrderSagaNotFoundError } from '@modules/orders/domain/errors';
import { OrderSaga } from '@modules/orders/domain/order-saga';
import { OrderSagaStep } from '@modules/orders/domain/order-saga-step';
import { OrderSagasRepository } from '@modules/orders/infrastructure/order-sagas.repository';

import { orderFactory } from '../factories';
import { gate } from '../helpers/concurrency';
import { createIntModule, type IntModule } from '../helpers/int-module';
import { WS_ACME, WS_GLOBEX } from '../seed/ids';
import { testDb } from '../setup/db';

let app: IntModule;
let repo: OrderSagasRepository;

beforeAll(async () => {
  app = await createIntModule({ providers: [OrderSagasRepository] });
  repo = app.get(OrderSagasRepository);
});
afterAll(() => app.close());

const inAcmeTx = <T>(work: () => Promise<T>): Promise<T> => app.inWorkspaceTx(WS_ACME, work);
const inGlobexTx = <T>(work: () => Promise<T>): Promise<T> => app.inWorkspaceTx(WS_GLOBEX, work);

const NOW = new Date('2026-10-10T10:00:00.000Z');
const LATER = new Date('2026-10-10T10:00:05.000Z');
const DEADLINE = new Date('2026-10-10T10:01:00.000Z');

const stored = (orderId: string, attempt = 1) =>
  testDb().orderSaga.findFirstOrThrow({ where: { orderId, attempt } });

/** A draft order of acme and, in the database, the saga of its first placing in RESERVING. */
async function started(): Promise<string> {
  const { id } = await orderFactory.create();
  await inAcmeTx(() =>
    repo.insert(
      OrderSaga.start({
        workspaceId: WS_ACME,
        orderId: id,
        attempt: 1,
        now: NOW,
        deadline: DEADLINE,
      }),
    ),
  );
  return id;
}

describe('OrderSagasRepository — a saga is stored as it is', () => {
  it('inserts the saga of an attempt and reads it back', async () => {
    const id = await started();

    const saga = await inAcmeTx(() => repo.getByAttempt(id, 1));

    expect(saga.snapshot()).toEqual({
      workspaceId: WS_ACME,
      orderId: id,
      attempt: 1,
      step: OrderSagaStep.Reserving,
      deadlineAt: DEADLINE,
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('keeps one saga per attempt of an order', async () => {
    const id = await started();
    await inAcmeTx(() =>
      repo.insert(
        OrderSaga.start({
          workspaceId: WS_ACME,
          orderId: id,
          attempt: 2,
          now: LATER,
          deadline: DEADLINE,
        }),
      ),
    );

    const [first, second] = await inAcmeTx(() =>
      Promise.all([repo.getByAttempt(id, 1), repo.getByAttempt(id, 2)]),
    );

    expect([first.attempt, second.attempt]).toEqual([1, 2]);
    expect(second.snapshot().createdAt).toEqual(LATER);
  });

  it('SAGA-013 reports an attempt that has no saga as not found', async () => {
    const id = await started();

    expect(await inAcmeTx(() => repo.findByAttempt(id, 7))).toBeNull();
    await expect(inAcmeTx(() => repo.getByAttempt(id, 7))).rejects.toThrow(OrderSagaNotFoundError);
  });
});

describe('OrderSagasRepository.save — version (SAGA-012)', () => {
  it('writes the step and its deadline, and increments version by exactly 1', async () => {
    const id = await started();

    await inAcmeTx(async () => {
      const saga = await repo.getByAttempt(id, 1);
      saga.stockReserved(LATER);
      saga.waitUntil(DEADLINE);
      await repo.save(saga);
    });

    expect(await stored(id)).toMatchObject({
      step: 'CHARGING',
      deadlineAt: DEADLINE,
      updatedAt: LATER,
      version: 1,
    });
  });

  it('rejects a write based on a version another transaction already replaced', async () => {
    const id = await started();
    const loaded = { a: gate(), b: gate() };

    // A: the answer of inventory
    const txA = inAcmeTx(async () => {
      const saga = await repo.getByAttempt(id, 1); // version 0
      loaded.a.open();
      await loaded.b.opened; // both hold version 0 before anyone writes
      saga.stockReserved(LATER);
      saga.waitUntil(DEADLINE);
      await repo.save(saga);
    });
    // B: the timeout of the same step, at the same moment
    const txB = inAcmeTx(async () => {
      const saga = await repo.getByAttempt(id, 1); // version 0
      loaded.b.open();
      await loaded.a.opened;
      await txA.catch(() => undefined); // A commits first
      saga.timedOut(OrderSagaStep.Reserving, LATER);
      saga.waitUntil(DEADLINE);
      await repo.save(saga);
    });

    await expect(txA).resolves.toBeUndefined();
    await expect(txB).rejects.toThrow(ConcurrencyError);
    // the answer stands; the timeout comes again and finds the step answered
    expect(await stored(id)).toMatchObject({ step: 'CHARGING', version: 1 });
  });
});

describe('order_sagas is a tenant table (SAGA-015)', () => {
  it('does not find the saga of an acme order from globex', async () => {
    const id = await started();

    expect(await inGlobexTx(() => repo.findByAttempt(id, 1))).toBeNull();
  });

  it('does not write over it from globex either: the save finds nothing to update', async () => {
    const id = await started();
    const saga = await inAcmeTx(() => repo.getByAttempt(id, 1));
    saga.stockReserved(LATER);
    saga.waitUntil(DEADLINE);

    await expect(inGlobexTx(() => repo.save(saga))).rejects.toThrow();

    expect(await stored(id)).toMatchObject({ step: 'RESERVING', version: 0 });
  });

  it('goes with its order: deleting the order deletes its sagas', async () => {
    const id = await started();

    await testDb().order.delete({ where: { workspaceId_id: { workspaceId: WS_ACME, id } } });

    expect(await testDb().orderSaga.count({ where: { orderId: id } })).toBe(0);
  });
});

describe('order_sagas — constraints of the table', () => {
  const row = (orderId: string, overrides: Record<string, unknown> = {}) => ({
    workspaceId: WS_ACME,
    orderId,
    attempt: 1,
    step: 'RESERVING' as const,
    deadlineAt: DEADLINE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  it('refuses a second saga for the same attempt of an order', async () => {
    const id = await started();

    await expect(testDb().orderSaga.create({ data: row(id) })).rejects.toThrow(/Unique constraint/);
  });

  it.each([
    ['attempt 0', { attempt: 0 }, 'order_sagas_attempt_chk'],
    ['a step that waits without a deadline', { deadlineAt: null }, 'order_sagas_deadline_chk'],
    ['a saga that has ended with a deadline', { step: 'ABORTED' }, 'order_sagas_deadline_chk'],
  ])('refuses %s', async (_case, overrides, constraint) => {
    const { id } = await orderFactory.create();

    await expect(testDb().orderSaga.create({ data: row(id, overrides) })).rejects.toThrow(
      constraint,
    );
  });

  it('refuses a saga of an order that does not exist in that workspace', async () => {
    const { id } = await orderFactory.create({ workspaceId: WS_GLOBEX });

    await expect(testDb().orderSaga.create({ data: row(id) })).rejects.toThrow(
      /Foreign key constraint/,
    );
  });
});
