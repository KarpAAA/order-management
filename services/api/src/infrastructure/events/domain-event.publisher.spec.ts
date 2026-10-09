import { describe, expect, it } from 'vitest';

import { recordingOutbox } from '@infra/outbox/__test__/recording-outbox';
import type { OutboxEntry } from '@infra/outbox/outbox';
import { ReliableEvents } from '@infra/outbox/reliable-events';
import type { DomainEvent } from '@shared/events/domain-event';
import { runInUnitOfWork } from '@shared/events/unit-of-work';

import { DomainEventPublisher } from './domain-event.publisher';

import type { EventBus } from '@nestjs/cqrs';

const AT = new Date('2026-10-08T10:00:00.000Z');

class Shipped implements DomainEvent {
  readonly name = 'parcel.shipped';
  readonly delivery = 'reliable' as const;
  readonly occurredAt = AT;
}

class Viewed implements DomainEvent {
  readonly name = 'parcel.viewed';
  readonly delivery = 'in-process' as const;
  readonly occurredAt = AT;
}

const ENTRY: OutboxEntry = {
  exchange: 'events',
  message: { messageId: 'm-1', name: 'parcels.parcel-shipped', occurredAt: AT.toISOString() },
};

function publisherWith(reliable = new ReliableEvents()) {
  const dispatched: DomainEvent[] = [];
  const eventBus = { publish: (e: DomainEvent) => dispatched.push(e) } as unknown as EventBus;
  const { outbox, appended } = recordingOutbox();
  return {
    publisher: new DomainEventPublisher(eventBus, reliable, outbox),
    reliable,
    dispatched,
    appended,
  };
}

describe('DomainEventPublisher', () => {
  it('OBX-001 writes a reliable event to the outbox at once, as its module translated it', async () => {
    const { publisher, reliable, appended, dispatched } = publisherWith();
    reliable.register(Shipped, () => Promise.resolve([ENTRY]));

    await runInUnitOfWork(async () => {
      await publisher.publishAll([new Shipped()]);
      // inside the unit of work, where the transaction of the use case is still open
      expect(appended).toEqual([ENTRY]);
    });

    expect(dispatched).toEqual([]);
  });

  it('refuses a reliable event nobody translates, instead of dropping it', async () => {
    const { publisher, appended } = publisherWith();

    await expect(publisher.publishAll([new Shipped()])).rejects.toThrow(/parcel\.shipped/);
    expect(appended).toEqual([]);
  });

  it('hands an in-process event to the event bus only after the unit of work', async () => {
    const { publisher, dispatched, appended } = publisherWith();
    const event = new Viewed();

    await runInUnitOfWork(async () => {
      await publisher.publishAll([event]);
      expect(dispatched).toEqual([]);
    });

    expect(dispatched).toEqual([event]);
    expect(appended).toEqual([]);
  });
});
