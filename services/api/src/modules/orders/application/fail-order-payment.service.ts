import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrderSagaSteps } from './order-saga-steps';
import { OrdersPolicy } from './orders.policy';

import type { FailOrderPaymentCommand } from './order-commands';

/** The reason of an order whose charge was cancelled because payments did not answer in time. */
export const PAYMENT_TIMEOUT = 'payment_timeout';

/**
 * PENDING_PAYMENT → PAYMENT_FAILED with a reason (a decline code, `psp_unavailable`,
 * `expired`, or `payment_timeout` for a charge that was cancelled), and the compensation of
 * the saga: no money was taken, so the stock that is held for the attempt is given back.
 * The order is PAYMENT_FAILED at once; the saga ends when inventory has answered.
 */
@UseCase()
export class FailOrderPaymentService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly sagas: OrderSagaSteps,
    private readonly policy: OrdersPolicy,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  @Transactional()
  async execute(cmd: FailOrderPaymentCommand, actor: Actor): Promise<void> {
    const order = await this.orders.getById(cmd.orderId);
    this.policy.assertCanSettlePayment(actor);
    const now = this.clock.now();
    order.markPaymentFailed({
      attempt: cmd.paymentAttempt,
      reason: cmd.reason,
      now,
      changedBy: actorRef(actor),
    });
    const saga = await this.sagas.getByAttempt(cmd.orderId, cmd.paymentAttempt);
    saga.paymentEnded(now);

    await this.sagas.save(saga);
    await this.orders.save(order);
    await this.sagas.releaseStock(saga);
    await this.events.publishAll(order.pullEvents());
  }
}
