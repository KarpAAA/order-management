import { StaleVersionError } from '../errors/domain-error';

import type { DomainEvent } from '../events/domain-event';

export abstract class AggregateRoot {
  private events: DomainEvent[] = [];

  abstract get id(): string;
  abstract get version(): number;

  /** Client-side half of optimistic locking: the command carries the version the client saw. */
  assertVersion(expected: number): void {
    if (expected !== this.version) {
      throw new StaleVersionError(this.constructor.name, this.id, expected, this.version);
    }
  }

  pullEvents(): DomainEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  protected record(event: DomainEvent): void {
    this.events.push(event);
  }
}
