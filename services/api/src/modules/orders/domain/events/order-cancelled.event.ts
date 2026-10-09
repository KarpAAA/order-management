import type { DomainEvent } from '@shared/events/domain-event';

import type { OrderRef } from './order-ref';

/** The order was cancelled and will not be fulfilled. Reliable. */
export class OrderCancelled implements DomainEvent {
  readonly name = 'order.cancelled';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly order: OrderRef,
    readonly occurredAt: Date,
  ) {}
}
