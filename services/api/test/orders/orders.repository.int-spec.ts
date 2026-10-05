// OrdersRepository against Postgres: optimistic locking (ORD-010). The subject is save() and
// its SQL, so the test drives the real repository directly; a use case cannot be paused
// between its read and its write, and a lost update needs exactly that interleaving.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConcurrencyError } from '@shared/errors/domain-error';

import { OrderStatus } from '@modules/orders/domain/order-status';
import { OrdersRepository } from '@modules/orders/infrastructure/orders.repository';

import { orderFactory } from '../factories';
import { gate, untilSomeoneWaitsOnLock } from '../helpers/concurrency';
import { createIntModule, type IntModule } from '../helpers/int-module';
import { USER_ACME_ADMIN, USER_ACME_MEMBER, WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

let app: IntModule;
let repo: OrdersRepository;

beforeAll(async () => {
  app = await createIntModule({ providers: [OrdersRepository] });
  repo = app.get(OrdersRepository);
});
afterAll(() => app.close());

const inAcmeTx = <T>(work: () => Promise<T>): Promise<T> => app.inWorkspaceTx(WS_ACME, work);
// a minute ahead: every change lands after the factory's ORDER_CREATED in the history
const later = (changedBy: string) => ({ now: new Date(Date.now() + 60_000), changedBy });
const byMember = () => later(USER_ACME_MEMBER);
const byAdmin = () => later(USER_ACME_ADMIN);

const stored = (id: string) => testDb().order.findFirstOrThrow({ where: { id } });
const historyOf = async (id: string) =>
  (
    await testDb().orderEvent.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } })
  ).map((e) => e.type);

describe('OrdersRepository.save — version (ORD-010)', () => {
  it('increments version by exactly 1 on every successful write', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });

    await inAcmeTx(async () => {
      const order = await repo.getById(id);
      order.place(byMember());
      await repo.save(order);
    });
    expect(await stored(id)).toMatchObject({ status: 'PENDING_PAYMENT', version: 1 });

    await inAcmeTx(async () => {
      const order = await repo.getById(id);
      expect(order.version).toBe(1);
      order.markPaid({ ...later('system:consumer:orders'), attempt: 1, pspChargeId: 'ch_1' });
      await repo.save(order);
    });
    expect(await stored(id)).toMatchObject({ status: 'PAID', version: 2 });
  });
});

describe('OrdersRepository.save — lost update', () => {
  it('rejects a write based on a version another transaction already replaced', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });
    const loaded = { a: gate(), b: gate() };

    // A: the member places the order
    const txA = inAcmeTx(async () => {
      const order = await repo.getById(id); // version 0
      loaded.a.open();
      await loaded.b.opened; // both hold version 0 before anyone writes
      order.place(byMember());
      await repo.save(order); // UPDATE … WHERE version = 0 → 1 row
    });

    // B: the admin cancels the same order at the same time
    const txB = inAcmeTx(async () => {
      const order = await repo.getById(id); // version 0 as well
      loaded.b.open();
      await loaded.a.opened;
      await txA.catch(() => undefined); // A has committed
      order.cancel(byAdmin());
      await repo.save(order); // UPDATE … WHERE version = 0 → 0 rows
    });

    await expect(txA).resolves.toBeUndefined();
    await expect(txB).rejects.toBeInstanceOf(ConcurrencyError);

    // A's write survived whole; nothing of B's, not even its history row
    expect(await stored(id)).toMatchObject({
      status: 'PENDING_PAYMENT',
      version: 1,
      cancelledAt: null,
    });
    expect(await historyOf(id)).toEqual(['ORDER_CREATED', 'ORDER_PLACED']);
  });

  it('rejects a write that waited for the row lock of an uncommitted winner', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });
    const loaded = { a: gate(), b: gate() };
    const aWrote = gate();

    // A: writes, then keeps its transaction open until B is blocked behind it
    const txA = inAcmeTx(async () => {
      const order = await repo.getById(id);
      loaded.a.open();
      await loaded.b.opened;
      order.place(byMember());
      await repo.save(order); // row locked by A, not committed
      aWrote.open();
      await untilSomeoneWaitsOnLock(testDb()); // B's UPDATE is now waiting for A
    }); // commit → Postgres re-checks B's WHERE version = 0 against the new row

    const txB = inAcmeTx(async () => {
      const order = await repo.getById(id);
      loaded.b.open();
      await aWrote.opened;
      order.cancel(byAdmin());
      await repo.save(order); // blocks on A's lock, then matches 0 rows
    });

    // both settle at A's commit, in either order: B's rejection needs its handler before then
    const rejectedB = expect(txB).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(txA).resolves.toBeUndefined();
    await rejectedB;
    expect(await stored(id)).toMatchObject({ status: 'PENDING_PAYMENT', version: 1 });
    expect(await historyOf(id)).toEqual(['ORDER_CREATED', 'ORDER_PLACED']);
  });
});
