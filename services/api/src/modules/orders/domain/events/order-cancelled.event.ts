import type { DomainEvent } from '@shared/events/domain-event';

/** The order was cancelled and will not be fulfilled. Reliable. */
export class OrderCancelled implements DomainEvent {
  readonly name = 'order.cancelled';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly workspaceId: string,
    readonly orderId: string,
    readonly occurredAt: Date,
  ) {}
}
