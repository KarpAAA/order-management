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

import type { RejectStockReservationCommand } from './order-commands';

/** Why an order that could not be reserved is back in DRAFT. */
export const OUT_OF_STOCK = 'out_of_stock';

/**
 * Inventory holds nothing for the attempt: the saga ends, and the order is a DRAFT again with
 * the reason and the products that fell short. Nothing is compensated, because nothing was
 * done: no stock is held and no charge was asked for.
 */
@UseCase()
export class RejectStockReservationService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly sagas: OrderSagaSteps,
    private readonly policy: OrdersPolicy,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  @Transactional()
  async execute(cmd: RejectStockReservationCommand, actor: Actor): Promise<void> {
    const saga = await this.sagas.getByAttempt(cmd.orderId, cmd.attempt);
    this.policy.assertCanAdvanceSaga(actor);
    const order = await this.orders.getById(cmd.orderId);
    const now = this.clock.now();
    saga.stockRefused(now);
    order.returnToDraft({
      attempt: cmd.attempt,
      reason: OUT_OF_STOCK,
      shortages: cmd.shortages,
      now,
      changedBy: actorRef(actor),
    });

    await this.sagas.save(saga);
    await this.orders.save(order);
    await this.events.publishAll(order.pullEvents());
  }
}
