import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { TenantContext } from '@common/tenancy/tenant-context';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { OrderEventType, OrderStatus } from '../domain/order-status';
import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrderSagaSteps } from './order-saga-steps';
import { OrdersPolicy } from './orders.policy';

import type { OrderActionCommand } from './order-commands';
import type { Order } from '../domain/order';

/**
 * How a request to cancel ended: the order is CANCELLED, or the request is with its saga and
 * the order still PENDING_PAYMENT until payments has said whether the charge was made.
 */
export type CancelOutcome = 'cancelled' | 'requested';

interface Change {
  now: Date;
  changedBy: string;
}

/**
 * DRAFT | PAYMENT_FAILED → CANCELLED: nothing is under way, the order is simply cancelled.
 *
 * PENDING_PAYMENT: a saga is running, and commands are on their way that this side cannot
 * take back. So the cancellation is a request to the saga of the attempt
 * (docs/adr/0017-order-saga.md):
 *  - the stock is still being reserved → no charge was asked for. The order is CANCELLED
 *    now, and inventory is asked to release whatever it holds or is about to hold;
 *  - the charge is under way → payments is asked not to make it. The order stays
 *    PENDING_PAYMENT: `payment-cancelled` or `payment-failed` ends it CANCELLED
 *    (`fail-order-payment.service.ts`), `payment-succeeded` ends it PAID;
 *  - payments was asked already, after a timeout → the request is remembered for its answer.
 */
@UseCase()
export class CancelOrderService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly sagas: OrderSagaSteps,
    private readonly policy: OrdersPolicy,
    private readonly tenant: TenantContext,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  @Transactional()
  async execute(cmd: OrderActionCommand, actor: Actor): Promise<CancelOutcome> {
    const order = await this.orders.getById(cmd.orderId);
    this.policy.assertCanWrite(actor, this.tenant.membership());
    order.assertVersion(cmd.version);
    const change = { now: this.clock.now(), changedBy: actorRef(actor) };

    if (order.status === OrderStatus.PendingPayment) return this.cancelThroughSaga(order, change);
    return this.cancel(order, change);
  }

  private async cancel(order: Order, change: Change): Promise<CancelOutcome> {
    order.cancel(change);
    await this.orders.save(order);
    await this.events.publishAll(order.pullEvents());
    return 'cancelled';
  }

  private async cancelThroughSaga(order: Order, change: Change): Promise<CancelOutcome> {
    const saga = await this.sagas.getByAttempt(order.id, order.paymentAttempt);
    const decision = saga.requestCancel(change.now);
    if (decision === 'already-requested') return 'requested';

    await this.sagas.save(saga);
    if (decision === 'cancel-now') {
      await this.sagas.releaseStock(saga);
      return this.cancel(order, change);
    }
    order.note(OrderEventType.CancellationRequested, { ...change, attempt: saga.attempt });
    await this.orders.save(order);
    if (decision === 'cancel-payment') await this.sagas.cancelPayment(saga);
    return 'requested';
  }
}
