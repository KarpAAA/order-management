import type { DomainEvent } from '@shared/events/domain-event';
import type { EventPublisher } from '@shared/events/event-publisher';

/** Spy: records what the use case published. Publishing leaves no state to read back. */
export class RecordingEventPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];

  publishAll(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events);
    return Promise.resolve();
  }
}
