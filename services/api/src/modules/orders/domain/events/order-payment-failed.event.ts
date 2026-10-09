import type { Money } from '@shared/domain/money';
import type { DomainEvent } from '@shared/events/domain-event';

import type { OrderRef } from './order-ref';

/**
 * The payment attempt the order waited for ended without a charge:
 * PENDING_PAYMENT → PAYMENT_FAILED. Reliable.
 */
export class OrderPaymentFailed implements DomainEvent {
  readonly name = 'order.payment-failed';
  readonly delivery = 'reliable' as const;

  constructor(
    readonly order: OrderRef,
    readonly paymentAttempt: number,
    readonly reason: string,
    readonly amountDue: Money,
    readonly occurredAt: Date,
  ) {}
}
