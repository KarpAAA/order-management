import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { TenantContext } from '@common/tenancy/tenant-context';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrderSagaSteps } from './order-saga-steps';
import { OrdersPolicy } from './orders.policy';

import type { OrderActionCommand } from './order-commands';

/**
 * DRAFT | PAYMENT_FAILED → PENDING_PAYMENT, a new payment attempt, and the first step of its
 * saga (docs/adr/0017-order-saga.md): the stock of the order is asked for. The charge follows
 * when inventory says the stock is held (`confirm-stock-reservation.service.ts`).
 *
 * The order, the saga, the command, its timeout and `OrderPlaced` are one transaction: the
 * command and the timeout are rows of the outbox, so an order never waits for a reservation
 * nobody was asked for, nor without a limit.
 */
@UseCase()
export class PlaceOrderService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly sagas: OrderSagaSteps,
    private readonly policy: OrdersPolicy,
    private readonly tenant: TenantContext,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  @Transactional()
  async execute(cmd: OrderActionCommand, actor: Actor): Promise<void> {
    const order = await this.orders.getById(cmd.orderId);
    this.policy.assertCanWrite(actor, this.tenant.membership());
    order.assertVersion(cmd.version);
    const now = this.clock.now();
    order.place({ now, changedBy: actorRef(actor) });
    await this.orders.save(order);
    await this.sagas.start(order, now);
    await this.events.publishAll(order.pullEvents());
  }
}
