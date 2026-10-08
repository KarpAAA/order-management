import type { Money } from '@shared/domain/money';
import type { DomainEvent } from '@shared/events/domain-event';

/**
 * An order entered PENDING_PAYMENT for `paymentAttempt`. Reliable: written to the outbox in
 * the transaction of the placement and published as `orders.order-placed`
 * (infrastructure/order-events.translator.ts).
 *
 * It carries the amount to charge: whoever reads the event cannot read the order.
 */
export class OrderPlaced implements DomainEvent {
  readonly name = 'order.placed';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly workspaceId: string,
    readonly orderId: string,
    readonly paymentAttempt: number,
    readonly amountDue: Money,
    readonly occurredAt: Date,
  ) {}
}
