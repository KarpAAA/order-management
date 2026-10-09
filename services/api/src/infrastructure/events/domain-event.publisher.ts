import { Injectable } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';

import { Outbox } from '@infra/outbox/outbox';
import { ReliableEvents } from '@infra/outbox/reliable-events';
import type { DomainEvent } from '@shared/events/domain-event';
import type { EventPublisher } from '@shared/events/event-publisher';
import { afterCommit } from '@shared/events/unit-of-work';

/**
 * Dispatches by `delivery`.
 *  - `in-process`: handed to the `@nestjs/cqrs` EventBus after the surrounding transaction
 *    commits; lost if the process dies in between.
 *  - `reliable`: translated into the messages its module registered and written to the outbox
 *    now, inside the transaction of the use case (docs/adr/0014-transactional-outbox.md).
 */
@Injectable()
export class DomainEventPublisher implements EventPublisher {
  constructor(
    private readonly eventBus: EventBus,
    private readonly reliable: ReliableEvents,
    private readonly outbox: Outbox,
  ) {}

  async publishAll(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      if (event.delivery === 'reliable') {
        for (const entry of await this.reliable.translate(event)) await this.outbox.append(entry);
        continue;
      }
      await afterCommit(() => {
        this.eventBus.publish(event);
      });
    }
  }
}
