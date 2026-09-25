import { Injectable } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';

import type { DomainEvent } from '@shared/events/domain-event';
import type { EventPublisher } from '@shared/events/event-publisher';
import { afterCommit } from '@shared/events/unit-of-work';

/**
 * Dispatches by `delivery`. Step 0 has only `in-process` events: they are handed to the
 * `@nestjs/cqrs` EventBus after the surrounding transaction commits. `reliable` events
 * (outbox) arrive in Step 3 and are rejected until then, so nothing silently degrades.
 */
@Injectable()
export class DomainEventPublisher implements EventPublisher {
  constructor(private readonly eventBus: EventBus) {}

  async publishAll(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      if (event.delivery === 'reliable') {
        throw new Error(`Reliable delivery (outbox) is not available yet: ${event.name}`);
      }
      await afterCommit(() => {
        this.eventBus.publish(event);
      });
    }
  }
}
