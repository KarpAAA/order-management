import type { DomainEvent } from '@shared/events/domain-event';

import type { OrderRef } from './order-ref';

/** A paid order was handed over: PAID → FULFILLED. Reliable. */
export class OrderFulfilled implements DomainEvent {
  readonly name = 'order.fulfilled';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly order: OrderRef,
    readonly occurredAt: Date,
  ) {}
}
