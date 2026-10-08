import type { DomainEvent } from '@shared/events/domain-event';

/** A paid order was handed over: PAID → FULFILLED. Reliable. */
export class OrderFulfilled implements DomainEvent {
  readonly name = 'order.fulfilled';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly workspaceId: string,
    readonly orderId: string,
    readonly occurredAt: Date,
  ) {}
}
