import type { DomainEvent } from '@shared/events/domain-event';

/**
 * An order entered PENDING_PAYMENT for `paymentAttempt`. In-process only in Step 0: its
 * handler enqueues the charge after commit, and the enqueue is NOT atomic with the commit
 * (docs/architecture.md → Known gaps; Step 3 moves it to the outbox).
 */
export class OrderPlaced implements DomainEvent {
  readonly name = 'order.placed';
  readonly delivery = 'in-process' as const;

  constructor(
    readonly workspaceId: string,
    readonly orderId: string,
    readonly paymentAttempt: number,
    readonly occurredAt: Date,
  ) {}
}
