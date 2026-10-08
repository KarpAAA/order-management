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

import type { CompleteOrderPaymentCommand } from './order-commands';

/**
 * PENDING_PAYMENT → PAID for exactly the attempt that was charged, and the end of its saga.
 * Also the answer to a cancellation of the payment that came too late: the charge was made,
 * so the order is paid.
 */
@UseCase()
export class CompleteOrderPaymentService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly sagas: OrderSagaSteps,
    private readonly policy: OrdersPolicy,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  @Transactional()
  async execute(cmd: CompleteOrderPaymentCommand, actor: Actor): Promise<void> {
    const order = await this.orders.getById(cmd.orderId);
    this.policy.assertCanSettlePayment(actor);
    const now = this.clock.now();
    order.markPaid({
      attempt: cmd.paymentAttempt,
      pspChargeId: cmd.pspChargeId,
      now,
      changedBy: actorRef(actor),
    });
    const saga = await this.sagas.getByAttempt(cmd.orderId, cmd.paymentAttempt);
    saga.paymentSucceeded(now);

    await this.sagas.save(saga);
    await this.orders.save(order);
    await this.events.publishAll(order.pullEvents());
  }
}
