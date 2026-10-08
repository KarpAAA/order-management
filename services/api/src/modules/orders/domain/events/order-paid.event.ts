import type { DomainEvent } from '@shared/events/domain-event';

/** The payment attempt the order waited for was charged: PENDING_PAYMENT → PAID. Reliable. */
export class OrderPaid implements DomainEvent {
  readonly name = 'order.paid';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly workspaceId: string,
    readonly orderId: string,
    readonly paymentAttempt: number,
    readonly pspChargeId: string,
    readonly occurredAt: Date,
  ) {}
}
