import type { DomainEvent } from './domain-event';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/**
 * The only thing a use case knows about events. The implementation decides *when* each
 * event actually fires based on its `delivery` (after commit for `in-process`).
 */
export interface EventPublisher {
  publishAll(events: readonly DomainEvent[]): Promise<void>;
}
