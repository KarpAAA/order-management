/**
 * `in-process`: dispatched after commit to handlers in the same process; lost if the
 * process dies in between.
 * `reliable`: written to the outbox in the transaction that recorded it and published to the
 * broker by the relay; delivered at least once (docs/adr/0014-transactional-outbox.md).
 */
export type EventDelivery = 'in-process' | 'reliable';

export interface DomainEvent {
  /** `<module>.<fact>` in lower dot-case, past tense: `order.placed`. */
  readonly name: string;
  readonly occurredAt: Date;
  readonly delivery: EventDelivery;
}
