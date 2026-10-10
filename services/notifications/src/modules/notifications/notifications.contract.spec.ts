// The service against the contracts (docs/adr/0021-contract-testing.md), without a broker and
// without the api: its queue is bound to what the map of parties says it reads, and it
// handles a message of each of those contracts as it was written on the day the version was
// released. The service writes no message.
import { RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import { consumedBy, contractKey, producedBy } from '@oms/contracts';
import { bindingProblems, releasedSample, type Binding } from '@oms/contracts/testing';
import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '@shared/logger/silent-logger';
import type { Inbox } from '@shared/messaging/inbox';

import { OrderEventsConsumer } from './interface/worker/order-events.consumer';

import type { RequestNotificationService } from './application/request-notification.service';

const SERVICE = 'notifications';

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

const READ = consumedBy(SERVICE).map((party) => ({
  key: contractKey(party.contract.name, party.contract.version),
  contract: party.contract,
}));

describe('notifications as a consumer', () => {
  it('CTR-020 binds its queue to the contracts the map gives it, and to nothing else', () => {
    const bindings = bindingsOf(OrderEventsConsumer);

    expect(bindings).toHaveLength(1);
    expect(bindingProblems(SERVICE, bindings)).toEqual([]);
  });

  it.each(READ)('CTR-021 handles $key as it was released', async ({ contract }) => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const consumer = new OrderEventsConsumer(
      inbox,
      { execute } as unknown as RequestNotificationService,
      silentLogger,
    );

    await expect(consumer.onOrderEvent(releasedSample(contract))).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('notifications as a producer', () => {
  it('CTR-030 writes no message', () => {
    expect(producedBy(SERVICE)).toEqual([]);
  });
});
