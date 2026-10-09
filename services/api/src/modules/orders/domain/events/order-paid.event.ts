import type { Money } from '@shared/domain/money';
import type { DomainEvent } from '@shared/events/domain-event';

import type { OrderRef } from './order-ref';

/** The payment attempt the order waited for was charged: PENDING_PAYMENT → PAID. Reliable. */
export class OrderPaid implements DomainEvent {
  readonly name = 'order.paid';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly order: OrderRef,
    readonly paymentAttempt: number,
    readonly pspChargeId: string,
    readonly amountDue: Money,
    readonly occurredAt: Date,
  ) {}
}
