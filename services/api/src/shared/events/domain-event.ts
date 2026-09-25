/**
 * `in-process`: dispatched after commit to handlers in the same process; lost if the
 * process dies in between. `reliable` (outbox) arrives in Step 3.
 */
export type EventDelivery = 'in-process' | 'reliable';

export interface DomainEvent {
  /** `<module>.<fact>` in lower dot-case, past tense: `order.placed`. */
  readonly name: string;
  readonly occurredAt: Date;
  readonly delivery: EventDelivery;
}
