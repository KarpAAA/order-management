import type { Money } from '@shared/domain/money';
import type { DomainEvent } from '@shared/events/domain-event';

/**
 * An order entered PENDING_PAYMENT for `paymentAttempt`. In-process: its handler asks
 * payments-service for the charge after commit, and that request is NOT atomic with the
 * commit (docs/architecture.md → Known gaps; ROADMAP 3.4 moves it to the outbox).
 *
 * It carries the amount to charge: the service that charges cannot read the order.
 */
export class OrderPlaced implements DomainEvent {
  readonly name = 'order.placed';
  readonly delivery = 'in-process' as const;

  constructor(
    readonly workspaceId: string,
    readonly orderId: string,
    readonly paymentAttempt: number,
    readonly amountDue: Money,
    readonly occurredAt: Date,
  ) {}
}
