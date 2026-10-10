import { Injectable } from '@nestjs/common';

import type { DomainEvent } from '@shared/events/domain-event';

type EventClass<E extends DomainEvent> = abstract new (...args: never[]) => E;
type Count<E extends DomainEvent> = (event: E) => void;

/**
 * Which domain events are counted as business metrics (docs/adr/0027). A module registers
 * the count of its own events (`<module>/infrastructure/*.meter.ts`), as it registers their
 * translations: a use case counts nothing, and this folder does not know the modules.
 *
 * The publisher calls a count after the commit of the unit of work, so an event of a write
 * that was rolled back is not counted.
 */
@Injectable()
export class EventMeters {
  private readonly counts = new Map<unknown, Count<DomainEvent>>();

  register<E extends DomainEvent>(event: EventClass<E>, count: Count<E>): void {
    this.counts.set(event, count as Count<DomainEvent>);
  }

  /** The count of this event, if its module registered one. */
  of(event: DomainEvent): (() => void) | undefined {
    const count = this.counts.get(event.constructor);
    return (
      count &&
      (() => {
        count(event);
      })
    );
  }
}
