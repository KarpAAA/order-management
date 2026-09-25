import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrdersPolicy } from './orders.policy';

import type { FailOrderPaymentCommand } from './order-commands';

/** PENDING_PAYMENT → PAYMENT_FAILED with a reason (decline code or `psp_unavailable`). */
@UseCase()
export class FailOrderPaymentService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly policy: OrdersPolicy,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  @Transactional()
  async execute(cmd: FailOrderPaymentCommand, actor: Actor): Promise<void> {
    const order = await this.orders.getById(cmd.orderId);
    this.policy.assertCanSettlePayment(actor);
    order.markPaymentFailed({
      attempt: cmd.paymentAttempt,
      reason: cmd.reason,
      now: this.clock.now(),
      changedBy: actorRef(actor),
    });
    await this.orders.save(order);
    await this.events.publishAll(order.pullEvents());
  }
}
