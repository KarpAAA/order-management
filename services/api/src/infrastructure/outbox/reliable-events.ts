import { Injectable } from '@nestjs/common';

import type { DomainEvent } from '@shared/events/domain-event';

import type { OutboxEntry } from './outbox';

type EventClass<E extends DomainEvent> = abstract new (...args: never[]) => E;
type Translate<E extends DomainEvent> = (event: E) => Promise<OutboxEntry[]>;

/**
 * Which messages a `reliable` domain event becomes on the broker. A module registers the
 * translation of its own events (`<module>/infrastructure/*.translator.ts`): the domain does
 * not know which of its events leave the service, and this folder does not know the modules.
 *
 * A translation is asynchronous: a contract may carry what the event only points at (the
 * address of the user behind an id), and the translator reads it, in the transaction of the
 * use case.
 */
@Injectable()
export class ReliableEvents {
  private readonly translations = new Map<unknown, Translate<DomainEvent>>();

  register<E extends DomainEvent>(event: EventClass<E>, translate: Translate<E>): void {
    this.translations.set(event, translate as Translate<DomainEvent>);
  }

  /** Throws for an event nobody registered: a reliable event must not vanish silently. */
  async translate(event: DomainEvent): Promise<OutboxEntry[]> {
    const translate = this.translations.get(event.constructor);
    if (!translate) throw new Error(`No outbox translation for reliable event ${event.name}`);
    return translate(event);
  }
}
