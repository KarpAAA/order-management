// The service against the contracts (docs/adr/0021-contract-testing.md), without a broker and
// without the api: its queue is bound to what the map of parties says it reads, it handles a
// message of each of those contracts as it was written on the day the version was released,
// and its adapter writes every contract the map says it writes, and no other.
import { RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import { consumedBy, contractKey, exchanges, parseMessage, producedBy } from '@oms/contracts';
import { bindingProblems, releasedSample, type Binding } from '@oms/contracts/testing';
import { describe, expect, it, vi } from 'vitest';

import { recordingOutbox } from '@infra/outbox/__test__/recording-outbox';
import type { OutboxEntry } from '@infra/outbox/outbox';
import { silentLogger } from '@shared/logger/silent-logger';
import type { Inbox } from '@shared/messaging/inbox';

import { fixedClock } from './application/__test__/fixtures';
import { ATTEMPT, NOW, PRODUCT_A, stockItem } from './domain/__test__/builders';
import { Reservation } from './domain/reservation';
import { OutboxInventoryEventsPublisher } from './infrastructure/outbox-inventory-events.adapter';
import { InventoryConsumer } from './interface/worker/inventory.consumer';

import type { AdjustStockService } from './application/adjust-stock.service';
import type { ReleaseStockService } from './application/release-stock.service';
import type { ReserveStockService } from './application/reserve-stock.service';
import type { InventoryEventsPublisher } from './ports/inventory-events-publisher.port';
import type { Party } from '@oms/contracts';

const SERVICE = 'inventory';
const CORRELATION_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03';

const keyOf = (party: Party): string => contractKey(party.contract.name, party.contract.version);

/** What the `@RabbitSubscribe` methods of a consumer class ask of the broker. */
const bindingsOf = (consumer: { prototype: object }): Binding[] =>
  Object.values(Object.getOwnPropertyDescriptors(consumer.prototype)).flatMap((descriptor) => {
    const method: unknown = descriptor.value;
    if (typeof method !== 'function') return [];
    const binding = Reflect.getMetadata(RABBIT_HANDLER, method) as Binding | undefined;
    return binding ? [binding] : [];
  });

/** The inbox without a database: every message is new. */
const inbox: Inbox = {
  once: async (_consumer, _messageId, handle) => {
    await handle();
    return true;
  },
};

describe('inventory as a consumer', () => {
  const READ = consumedBy(SERVICE).map((party) => ({ key: keyOf(party), ...party }));

  it('CTR-020 binds its queue to the contracts the map gives it, and to nothing else', () => {
    const bindings = bindingsOf(InventoryConsumer);

    expect(bindings).toHaveLength(1);
    expect(bindingProblems(SERVICE, bindings)).toEqual([]);
  });

  it.each(READ)('CTR-021 handles $key as it was released', async ({ contract }) => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const consumer = new InventoryConsumer(
      inbox,
      { execute } as unknown as ReserveStockService,
      { execute } as unknown as ReleaseStockService,
      { execute } as unknown as AdjustStockService,
      silentLogger,
    );

    await expect(consumer.onCommand(releasedSample(contract))).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('inventory as a producer', () => {
  const held = Reservation.hold({
    ...ATTEMPT,
    now: NOW,
    lines: [{ productId: PRODUCT_A, quantity: 2 }],
  });
  const rejected = Reservation.reject({
    ...ATTEMPT,
    now: NOW,
    lines: [{ productId: PRODUCT_A, quantity: 5, available: 1 }],
  });

  /** How the service comes to write each contract: the real adapter, asked as a use case asks. */
  const EMITTERS: Record<string, (publisher: InventoryEventsPublisher) => Promise<void>> = {
    'inventory.stock-reserved@1': (p) => p.reservationAnswered(held, CORRELATION_ID),
    'inventory.stock-reservation-failed@1': (p) => p.reservationAnswered(rejected, CORRELATION_ID),
    'inventory.stock-released@1': (p) => p.stockReleased(ATTEMPT, CORRELATION_ID),
    'inventory.stock-adjusted@1': (p) => p.stockAdjusted(stockItem(), CORRELATION_ID),
  };

  async function written(key: string): Promise<OutboxEntry> {
    const { outbox, appended } = recordingOutbox();
    await EMITTERS[key]?.(new OutboxInventoryEventsPublisher(outbox, fixedClock));
    expect(appended).toHaveLength(1);
    return appended[0]!;
  }

  const WRITTEN = producedBy(SERVICE).map((party) => ({ key: keyOf(party), ...party }));

  it('CTR-030 writes the contracts the map gives it, and no other', () => {
    expect(Object.keys(EMITTERS).sort()).toEqual(WRITTEN.map(({ key }) => key).sort());
  });

  it.each(WRITTEN)('CTR-030 writes $key as its readers accept it', async ({ key, exchange }) => {
    const entry = await written(key);

    const read = parseMessage(JSON.parse(JSON.stringify(entry.message)));
    expect(read).toMatchObject({ ok: true });
    expect(read.ok && contractKey(read.message.name, read.message.version)).toBe(key);
    expect(entry.exchange).toBe(exchanges[exchange].name);
  });
});
