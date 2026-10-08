import { Injectable } from '@nestjs/common';

import type { DomainEvent } from '@shared/events/domain-event';

import type { OutboxEntry } from './outbox';

type EventClass<E extends DomainEvent> = abstract new (...args: never[]) => E;
type Translate<E extends DomainEvent> = (event: E) => OutboxEntry[];

/**
 * Which messages a `reliable` domain event becomes on the broker. A module registers the
 * translation of its own events (`<module>/infrastructure/*.translator.ts`): the domain does
 * not know which of its events leave the service, and this folder does not know the modules.
 */
@Injectable()
export class ReliableEvents {
  private readonly translations = new Map<unknown, Translate<DomainEvent>>();

  register<E extends DomainEvent>(event: EventClass<E>, translate: Translate<E>): void {
    this.translations.set(event, translate as Translate<DomainEvent>);
  }

  /** Throws for an event nobody registered: a reliable event must not vanish silently. */
  translate(event: DomainEvent): OutboxEntry[] {
    const translate = this.translations.get(event.constructor);
    if (!translate) throw new Error(`No outbox translation for reliable event ${event.name}`);
    return translate(event);
  }
}
