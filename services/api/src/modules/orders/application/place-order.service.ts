import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { TenantContext } from '@common/tenancy/tenant-context';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';
import {
  PAYMENT_CHARGE_SCHEDULER,
  type PaymentChargeScheduler,
} from '../ports/payment-charge-scheduler.port';

import { OrdersPolicy } from './orders.policy';

import type { OrderActionCommand } from './order-commands';

/**
 * DRAFT | PAYMENT_FAILED → PENDING_PAYMENT, new payment attempt, and the request to charge
 * it: the first half of "pending + queue + second use case" (application/write-service.md §4).
 * The order, the charge request and `OrderPlaced` are one transaction: the request is a row
 * of the outbox, so an order never waits for a charge nobody was asked for.
 */
@UseCase()
export class PlaceOrderService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly policy: OrdersPolicy,
    private readonly tenant: TenantContext,
    private readonly clock: Clock,
    @Inject(PAYMENT_CHARGE_SCHEDULER) private readonly charges: PaymentChargeScheduler,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  @Transactional()
  async execute(cmd: OrderActionCommand, actor: Actor): Promise<void> {
    const order = await this.orders.getById(cmd.orderId);
    this.policy.assertCanWrite(actor, this.tenant.membership());
    order.assertVersion(cmd.version);
    order.place({ now: this.clock.now(), changedBy: actorRef(actor) });
    await this.orders.save(order);
    await this.charges.schedule({
      workspaceId: order.workspaceId,
      orderId: order.id,
      paymentAttempt: order.paymentAttempt,
      amount: order.amountDue,
    });
    await this.events.publishAll(order.pullEvents());
  }
}
