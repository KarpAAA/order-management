import { Inject, Logger } from '@nestjs/common';
import { EventsHandler } from '@nestjs/cqrs';

import { OrderPlaced } from '../../domain/events/order-placed.event';
import {
  PAYMENT_CHARGE_SCHEDULER,
  type PaymentChargeScheduler,
} from '../../ports/payment-charge-scheduler.port';

import type { IEventHandler } from '@nestjs/cqrs';

/**
 * Reaction to `OrderPlaced`: ask payments-service for the charge. Runs after the commit.
 *
 * KNOWN GAP (Step 0, on purpose): the request is not atomic with the commit. If the broker
 * is down or the process dies right here, the order stays PENDING_PAYMENT with no charge
 * under way, and PENDING_PAYMENT cannot be cancelled. ROADMAP 3.4 replaces this with a
 * transactional outbox.
 */
@EventsHandler(OrderPlaced)
export class SchedulePaymentChargeHandler implements IEventHandler<OrderPlaced> {
  private readonly logger = new Logger(SchedulePaymentChargeHandler.name);

  constructor(
    @Inject(PAYMENT_CHARGE_SCHEDULER) private readonly scheduler: PaymentChargeScheduler,
  ) {}

  async handle(event: OrderPlaced): Promise<void> {
    try {
      await this.scheduler.schedule({
        workspaceId: event.workspaceId,
        orderId: event.orderId,
        paymentAttempt: event.paymentAttempt,
        amount: event.amountDue,
      });
    } catch (err: unknown) {
      // In-process handlers never throw into the publisher: the order is already committed.
      this.logger.error(
        `failed to request charge orderId=${event.orderId} attempt=${event.paymentAttempt}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
