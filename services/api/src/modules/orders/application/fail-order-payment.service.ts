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
 * The payment of the attempt ended without a charge: declined, expired, or cancelled.
 * PENDING_PAYMENT → PAYMENT_FAILED with the reason (a decline code, `psp_unavailable`,
 * `expired`, or `payment_timeout` for a charge the saga cancelled), or → CANCELLED when the
 * user had asked to cancel the order: that is what they were waiting to hear.
 * Either way the saga compensates: no money was taken, so the stock that is held for the
 * attempt is given back. The order has its status at once; the saga ends when inventory has
 * answered.
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
    const change = { now, changedBy: actorRef(actor) };
    order.assertAwaitingPayment(cmd.paymentAttempt);
    const saga = await this.sagas.getByAttempt(cmd.orderId, cmd.paymentAttempt);
    saga.paymentEnded(now);
    if (saga.cancelRequested) order.cancel(change);
    else order.markPaymentFailed({ ...change, attempt: cmd.paymentAttempt, reason: cmd.reason });

    await this.sagas.save(saga);
    await this.orders.save(order);
    await this.sagas.releaseStock(saga);
    await this.events.publishAll(order.pullEvents());
  }
}
