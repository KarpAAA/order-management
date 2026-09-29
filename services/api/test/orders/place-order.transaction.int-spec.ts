// ORD-018: a status change and its history row commit together or not at all. The
// transaction boundary is PlaceOrderService's @Transactional(), so the test calls the real
// use case; a trigger makes the SECOND write (the history row) fail inside Postgres.
// Own file: the trigger lives in this file's database only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventsModule } from '@infra/events/events.module';
import { userActor } from '@shared/auth/actor';
import { WorkspaceRole } from '@shared/auth/workspace-role';
import { Clock, SystemClock } from '@shared/domain/clock';

import { OrdersPolicy } from '@modules/orders/application/orders.policy';
import { PlaceOrderService } from '@modules/orders/application/place-order.service';
import { OrderStatus } from '@modules/orders/domain/order-status';
import { OrdersRepository } from '@modules/orders/infrastructure/orders.repository';
import { ORDERS_REPOSITORY } from '@modules/orders/ports/orders-repository.port';

import { orderFactory } from '../factories';
import { createIntModule, type IntModule } from '../helpers/int-module';
import { USER_ACME_MEMBER, WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

let app: IntModule;
let placeOrder: PlaceOrderService;

beforeAll(async () => {
  app = await createIntModule({
    imports: [EventsModule], // OrderPlaced goes to an EventBus with no handler: no queue here
    providers: [
      PlaceOrderService,
      OrdersPolicy,
      OrdersRepository,
      { provide: ORDERS_REPOSITORY, useExisting: OrdersRepository },
      { provide: Clock, useClass: SystemClock },
    ],
  });
  placeOrder = app.get(PlaceOrderService);
});
afterAll(() => app.close());

const member = { workspaceId: WS_ACME, userId: USER_ACME_MEMBER, role: WorkspaceRole.Member };
const place = (orderId: string) =>
  app.asMember(member, () =>
    placeOrder.execute({ orderId, version: 0 }, userActor(USER_ACME_MEMBER)),
  );

/** Fault injection: every INSERT into `table` fails inside Postgres until restore(). */
async function failInsertsInto(table: string): Promise<() => Promise<void>> {
  await testDb().$executeRawUnsafe(`
    CREATE FUNCTION inject_failure() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected failure: %', TG_TABLE_NAME; END
    $$ LANGUAGE plpgsql`);
  await testDb().$executeRawUnsafe(
    `CREATE TRIGGER inject_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION inject_failure()`,
  );
  return async () => {
    await testDb().$executeRawUnsafe(`DROP TRIGGER inject_failure ON ${table}`);
    await testDb().$executeRawUnsafe('DROP FUNCTION inject_failure()');
  };
}

const stored = (id: string) => testDb().order.findFirstOrThrow({ where: { id } });
const historyOf = async (id: string) =>
  (await testDb().orderEvent.findMany({ where: { orderId: id } })).map((e) => e.type).sort();

describe('PlaceOrderService — status and history in one transaction (ORD-018)', () => {
  it('writes the new status, one version bump and exactly one history row', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });

    await place(id);

    expect(await stored(id)).toMatchObject({
      status: 'PENDING_PAYMENT',
      version: 1,
      paymentAttempt: 1,
    });
    expect(await historyOf(id)).toEqual(['ORDER_CREATED', 'ORDER_PLACED']);
  });

  it('rolls back the status change when the history row cannot be written', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });
    const restore = await failInsertsInto('order_events');
    try {
      await expect(place(id)).rejects.toThrow(/injected failure/);
    } finally {
      await restore();
    }

    // the UPDATE of orders ran first and succeeded — and was rolled back with the insert
    expect(await stored(id)).toMatchObject({ status: 'DRAFT', version: 0, placedAt: null });
    expect(await historyOf(id)).toEqual(['ORDER_CREATED']);
  });
});
