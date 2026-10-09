import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';

import { OrderEventType } from '../domain/order-status';
import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrderSagaSteps } from './order-saga-steps';
import { OrdersPolicy } from './orders.policy';

import type { StockAnswerCommand } from './order-commands';

/**
 * The stock of the attempt is given back: the compensation is done and the saga ends. The
 * order is not moved: it left PENDING_PAYMENT when the release was asked for, and may have
 * been placed again since. Its history says that the stock is free.
 */
@UseCase()
export class ConfirmStockReleaseService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly sagas: OrderSagaSteps,
    private readonly policy: OrdersPolicy,
    private readonly clock: Clock,
  ) {}

  @Transactional()
  async execute(cmd: StockAnswerCommand, actor: Actor): Promise<void> {
    const saga = await this.sagas.getByAttempt(cmd.orderId, cmd.attempt);
    this.policy.assertCanAdvanceSaga(actor);
    const order = await this.orders.getById(cmd.orderId);
    const now = this.clock.now();
    saga.stockReleased(now);
    order.note(OrderEventType.StockReleased, {
      attempt: cmd.attempt,
      now,
      changedBy: actorRef(actor),
    });

    await this.sagas.save(saga);
    await this.orders.save(order);
  }
}
