import type { DomainEvent } from '@shared/events/domain-event';

import type { OrderRef } from './order-ref';

/**
 * The attempt ended before a charge was asked for: PENDING_PAYMENT → DRAFT, with the reason
 * (the stock was not there, or inventory never said). Reliable.
 */
export class OrderReturnedToDraft implements DomainEvent {
  readonly name = 'order.returned-to-draft';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly order: OrderRef,
    readonly paymentAttempt: number,
    readonly reason: string,
    readonly occurredAt: Date,
  ) {}
}
