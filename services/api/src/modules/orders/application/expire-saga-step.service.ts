import { Inject, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { OrderEventType } from '../domain/order-status';
import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrderSagaSteps } from './order-saga-steps';
import { OrdersPolicy } from './orders.policy';

import type { ExpireSagaStepCommand } from './order-commands';

/** Why an order whose reservation was never answered is back in DRAFT. */
export const INVENTORY_UNAVAILABLE = 'inventory_unavailable';

/**
 * A step of the saga was not answered in time. A timeout says "I did not hear", never "it
 * did not happen", so what follows depends on what an answer that is still on its way could
 * mean (docs/adr/0017-order-saga.md):
 *  - RESERVING: nothing was charged. The order is a DRAFT again and whatever inventory may
 *    hold is released; a reservation that arrives later is released by that command;
 *  - CHARGING: money may have moved. Nothing is decided here: payments is asked not to
 *    charge, and its answer says how the attempt ended;
 *  - CANCELLING_PAYMENT, RELEASING: the question is still open and cannot be answered from
 *    this side. It is asked again, and somebody is told.
 * A timeout of a step the saga has left is an `InvalidStateError`: the answer came first.
 */
@UseCase()
export class ExpireSagaStepService {
  private readonly logger = new Logger(ExpireSagaStepService.name);

  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly sagas: OrderSagaSteps,
    private readonly policy: OrdersPolicy,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  @Transactional()
  async execute(cmd: ExpireSagaStepCommand, actor: Actor): Promise<void> {
    const saga = await this.sagas.getByAttempt(cmd.orderId, cmd.attempt);
    this.policy.assertCanAdvanceSaga(actor);
    const now = this.clock.now();
    const action = saga.timedOut(cmd.step, now);
    const change = { attempt: cmd.attempt, now, changedBy: actorRef(actor) };

    await this.sagas.save(saga);
    switch (action) {
      case 'release-stock': {
        const order = await this.orders.getById(cmd.orderId);
        order.returnToDraft({ ...change, reason: INVENTORY_UNAVAILABLE });
        await this.orders.save(order);
        await this.sagas.releaseStock(saga);
        await this.events.publishAll(order.pullEvents());
        return;
      }
      case 'cancel-payment': {
        const order = await this.orders.getById(cmd.orderId);
        order.assertAwaitingPayment(cmd.attempt);
        order.note(OrderEventType.PaymentTimedOut, change);
        await this.orders.save(order);
        await this.sagas.cancelPayment(saga);
        return;
      }
      case 'repeat-cancel-payment':
        this.logger.error(
          `order ${cmd.orderId}, attempt ${cmd.attempt}: payments has not said how the attempt ended; asked again`,
        );
        await this.sagas.cancelPayment(saga);
        return;
      case 'repeat-release-stock':
        this.logger.error(
          `order ${cmd.orderId}, attempt ${cmd.attempt}: inventory has not confirmed the release; asked again`,
        );
        await this.sagas.releaseStock(saga);
        return;
    }
  }
}
