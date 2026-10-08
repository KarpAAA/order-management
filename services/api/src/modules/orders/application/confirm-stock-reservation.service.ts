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
 * The stock of the attempt is held: RESERVING → CHARGING, and the charge is asked for. The
 * command expires when the step does: payments charges nothing for a command it handles
 * after the saga has stopped waiting. The order stays PENDING_PAYMENT; its history says that
 * the stock is held.
 */
@UseCase()
export class ConfirmStockReservationService {
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
    saga.stockReserved(now);
    order.assertAwaitingPayment(cmd.attempt);
    order.note(OrderEventType.StockReserved, {
      attempt: cmd.attempt,
      now,
      changedBy: actorRef(actor),
    });

    await this.sagas.save(saga);
    await this.orders.save(order);
    await this.sagas.charge(saga, order.amountDue);
  }
}
