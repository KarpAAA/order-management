// ORD-018, OBX-001: a status change, its history row and the messages it causes commit
// together or not at all. The transaction boundary is PlaceOrderService's @Transactional(),
// so the test calls the real use case; a trigger makes a LATER write (the history row, an
// outbox row) fail inside Postgres. Own file: the trigger lives in this file's database only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventsModule } from '@infra/events/events.module';
import { userActor } from '@shared/auth/actor';
import { WorkspaceRole } from '@shared/auth/workspace-role';
import { Clock, SystemClock } from '@shared/domain/clock';

import { OrdersPolicy } from '@modules/orders/application/orders.policy';
import { PlaceOrderService } from '@modules/orders/application/place-order.service';
import { OrderStatus } from '@modules/orders/domain/order-status';
import { OrderEventsTranslator } from '@modules/orders/infrastructure/order-events.translator';
import { OrdersRepository } from '@modules/orders/infrastructure/orders.repository';
import { OutboxPaymentChargeAdapter } from '@modules/orders/infrastructure/outbox-payment-charge.adapter';
import { ORDERS_REPOSITORY } from '@modules/orders/ports/orders-repository.port';
import { PAYMENT_CHARGE_SCHEDULER } from '@modules/orders/ports/payment-charge-scheduler.port';

import { orderFactory } from '../factories';
import { createIntModule, type IntModule } from '../helpers/int-module';
import { USER_ACME_MEMBER, WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

let app: IntModule;
let placeOrder: PlaceOrderService;

beforeAll(async () => {
  app = await createIntModule({
    imports: [EventsModule], // with the write side of the outbox; no relay, no broker here
    providers: [
      PlaceOrderService,
      OrdersPolicy,
      OrdersRepository,
      { provide: ORDERS_REPOSITORY, useExisting: OrdersRepository },
      { provide: PAYMENT_CHARGE_SCHEDULER, useClass: OutboxPaymentChargeAdapter },
      OrderEventsTranslator,
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
/** The messages waiting for the relay about the order: names, sorted. */
const outboxOf = async (id: string) =>
  (
    await testDb().outboxMessage.findMany({
      where: { payload: { path: ['payload', 'orderId'], equals: id }, publishedAt: null },
    })
  )
    .map((row) => `${row.exchange}:${row.routingKey}`)
    .sort();

describe('PlaceOrderService — status, history and messages in one transaction (ORD-018, OBX-001)', () => {
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

  it('OBX-001 writes the charge command and the event to the outbox in the same transaction', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });

    await place(id);

    expect(await outboxOf(id)).toEqual([
      'commands:payments.charge-payment',
      'events:orders.order-placed',
    ]);
    const [command] = await testDb().outboxMessage.findMany({
      where: {
        routingKey: 'payments.charge-payment',
        payload: { path: ['payload', 'orderId'], equals: id },
      },
    });
    expect(command?.payload).toMatchObject({
      messageId: command?.id,
      workspaceId: WS_ACME,
      payload: { paymentAttempt: 1, idempotencyKey: `${id}:1` },
    });
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
    expect(await outboxOf(id)).toEqual([]);
  });

  it('OBX-001 rolls back the order when a message cannot be written: no order waits for a charge nobody was asked for', async () => {
    const { id } = await orderFactory.create({ status: OrderStatus.Draft });
    const restore = await failInsertsInto('outbox');
    try {
      await expect(place(id)).rejects.toThrow(/injected failure/);
    } finally {
      await restore();
    }

    expect(await stored(id)).toMatchObject({ status: 'DRAFT', version: 0, placedAt: null });
    expect(await historyOf(id)).toEqual(['ORDER_CREATED']);
    expect(await outboxOf(id)).toEqual([]);
  });
});
