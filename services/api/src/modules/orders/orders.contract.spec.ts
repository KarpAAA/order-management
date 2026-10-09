// The api against the contracts (docs/adr/0021-contract-testing.md), without a broker and
// without the other services: its queues are bound to what the map of parties says it reads,
// it handles a message of each of those contracts as it was written on the day the version
// was released, and its adapters write every contract the map says it writes, and no other.
import { RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import { consumedBy, contractKey, exchanges, parseMessage, producedBy } from '@oms/contracts';
import { bindingProblems, releasedSample, type Binding } from '@oms/contracts/testing';
import { describe, expect, it, vi } from 'vitest';

import type { CorrelationContext } from '@common/messaging/correlation-context';
import type { TenantContext } from '@common/tenancy/tenant-context';
import { correlationOf, recordingOutbox } from '@infra/outbox/__test__/recording-outbox';
import { ReliableEvents } from '@infra/outbox/reliable-events';
import { Money } from '@shared/domain/money';
import type { DomainEvent } from '@shared/events/domain-event';
import type { Inbox } from '@shared/messaging/inbox';

import { fixedClock } from './application/__test__/fixtures';
import { LATER, ORDER, ORDER_REF, PRODUCT_1, WORKSPACE } from './domain/__test__/builders';
import { OrderCancelled } from './domain/events/order-cancelled.event';
import { OrderFulfilled } from './domain/events/order-fulfilled.event';
import { OrderPaid } from './domain/events/order-paid.event';
import { OrderPaymentFailed } from './domain/events/order-payment-failed.event';
import { OrderPlaced } from './domain/events/order-placed.event';
import { OrderReturnedToDraft } from './domain/events/order-returned-to-draft.event';
import { OrderEventsTranslator } from './infrastructure/order-events.translator';
import { OutboxPaymentChargeAdapter } from './infrastructure/outbox-payment-charge.adapter';
import { OutboxStockReservationAdapter } from './infrastructure/outbox-stock-reservation.adapter';
import { InventoryEventsConsumer } from './interface/worker/inventory-events.consumer';
import { PaymentEventsConsumer } from './interface/worker/payment-events.consumer';
import { SagaTimeoutsConsumer } from './interface/worker/saga-timeouts.consumer';

import type { OrderRecipients } from './ports/order-recipients.port';
import type { Party } from '@oms/contracts';

const SERVICE = 'api';
const CORRELATION = '01990000-0000-7000-8000-c00000000001';
const AMOUNT = Money.of(40_50n, 'EUR');
const PAYMENT = { workspaceId: WORKSPACE, orderId: ORDER, paymentAttempt: 2 };
const RESERVATION = { workspaceId: WORKSPACE, orderId: ORDER, attempt: 2 };

const keyOf = (party: Party): string => contractKey(party.contract.name, party.contract.version);

/** What the `@RabbitSubscribe` methods of a consumer class ask of the broker. */
const bindingsOf = (consumer: { prototype: object }): Binding[] =>
  Object.values(Object.getOwnPropertyDescriptors(consumer.prototype)).flatMap((descriptor) => {
    const method: unknown = descriptor.value;
    if (typeof method !== 'function') return [];
    const binding = Reflect.getMetadata(RABBIT_HANDLER, method) as Binding | undefined;
    return binding ? [binding] : [];
  });

describe('the api as a consumer', () => {
  /** The broker consumers of the worker with one spy for all their use cases. */
  function consumers() {
    const execute = vi.fn().mockResolvedValue(undefined);
    const useCase = { execute } as never;
    const tenant = {
      runInWorkspace: (_workspaceId: string, work: () => Promise<unknown>) => work(),
    } as unknown as TenantContext;
    const correlation = { continue: () => undefined } as unknown as CorrelationContext;
    // the inbox without a database: every message is new
    const inbox: Inbox = {
      once: async (_consumer, _messageId, handle) => {
        await handle();
        return true;
      },
    };
    const payments = new PaymentEventsConsumer(tenant, correlation, inbox, useCase, useCase);
    const inventory = new InventoryEventsConsumer(
      tenant,
      correlation,
      inbox,
      useCase,
      useCase,
      useCase,
    );
    return {
      execute,
      queues: [
        {
          binding: bindingsOf(PaymentEventsConsumer),
          deliver: (raw: unknown) => payments.onPaymentEvent(raw),
        },
        {
          binding: bindingsOf(InventoryEventsConsumer),
          deliver: (raw: unknown) => inventory.onInventoryEvent(raw),
        },
      ],
    };
  }

  const READ = consumedBy(SERVICE).map((party) => ({ key: keyOf(party), ...party }));

  it('CTR-020 binds its queues to the contracts the map gives it, and to nothing else', () => {
    // the timeouts of the saga are the api's own message on its own exchange: no contract
    const bindings = [PaymentEventsConsumer, InventoryEventsConsumer, SagaTimeoutsConsumer].flatMap(
      bindingsOf,
    );

    expect(bindings).toHaveLength(3);
    expect(bindingProblems(SERVICE, bindings)).toEqual([]);
  });

  it.each(READ)('CTR-021 handles $key as it was released', async ({ contract }) => {
    const { execute, queues } = consumers();
    const bound = queues.filter(({ binding }) =>
      binding.some(({ routingKey }) => [routingKey].flat().includes(contract.name)),
    );
    expect(bound).toHaveLength(1);

    await expect(bound[0]!.deliver(releasedSample(contract))).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('the api as a producer', () => {
  interface Written {
    exchange: string;
    message: unknown;
  }

  const recipients: OrderRecipients = {
    of: (userId) => Promise.resolve({ userId, email: 'buyer@example.com' }),
  };

  /** What the translation of a domain event of an order writes to the outbox. */
  async function translated(event: DomainEvent): Promise<Written[]> {
    const reliable = new ReliableEvents();
    new OrderEventsTranslator(correlationOf(CORRELATION), recipients, reliable);
    return reliable.translate(event);
  }

  /** What the adapters of the saga write to the outbox when a use case calls one. */
  async function sent(
    call: (adapters: {
      stock: OutboxStockReservationAdapter;
      charge: OutboxPaymentChargeAdapter;
    }) => Promise<void>,
  ): Promise<Written[]> {
    const { outbox, appended } = recordingOutbox();
    const correlation = correlationOf(CORRELATION);
    await call({
      stock: new OutboxStockReservationAdapter(outbox, fixedClock, correlation),
      charge: new OutboxPaymentChargeAdapter(outbox, fixedClock, correlation),
    });
    return appended;
  }

  /** How the api comes to write each contract: the real translator or adapter. */
  const EMITTERS: Record<string, () => Promise<Written[]>> = {
    'orders.order-placed@1': () => translated(new OrderPlaced(ORDER_REF, 2, AMOUNT, LATER)),
    'orders.order-paid@1': () => translated(new OrderPaid(ORDER_REF, 2, 'ch_1', AMOUNT, LATER)),
    'orders.order-cancelled@1': () => translated(new OrderCancelled(ORDER_REF, LATER)),
    'orders.order-fulfilled@1': () => translated(new OrderFulfilled(ORDER_REF, LATER)),
    'orders.order-payment-failed@1': () =>
      translated(new OrderPaymentFailed(ORDER_REF, 2, 'card_declined', AMOUNT, LATER)),
    'orders.order-returned-to-draft@1': () =>
      translated(new OrderReturnedToDraft(ORDER_REF, 2, 'out_of_stock', LATER)),
    'inventory.reserve-stock@1': () =>
      sent(({ stock }) =>
        stock.reserve({ ...RESERVATION, lines: [{ productId: PRODUCT_1, quantity: 2 }] }),
      ),
    'inventory.release-stock@1': () => sent(({ stock }) => stock.release(RESERVATION)),
    'payments.charge-payment@1': () =>
      sent(({ charge }) => charge.schedule({ ...PAYMENT, amount: AMOUNT, expiresAt: LATER })),
    'payments.cancel-payment@1': () => sent(({ charge }) => charge.cancel(PAYMENT)),
  };

  const WRITTEN = producedBy(SERVICE).map((party) => ({ key: keyOf(party), ...party }));

  it('CTR-030 writes the contracts the map gives it, and no other', () => {
    expect(Object.keys(EMITTERS).sort()).toEqual(WRITTEN.map(({ key }) => key).sort());
  });

  it.each(WRITTEN)('CTR-030 writes $key as its readers accept it', async ({ key, exchange }) => {
    const entries = await EMITTERS[key]!();

    expect(entries).toHaveLength(1);
    const read = parseMessage(JSON.parse(JSON.stringify(entries[0]!.message)));
    expect(read).toMatchObject({ ok: true });
    expect(read.ok && contractKey(read.message.name, read.message.version)).toBe(key);
    expect(entries[0]!.exchange).toBe(exchanges[exchange].name);
  });
});
