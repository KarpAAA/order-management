import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { TenantContext } from '@common/tenancy/tenant-context';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrdersPolicy } from './orders.policy';

import type { OrderActionCommand } from './order-commands';

/** DRAFT | PAYMENT_FAILED → CANCELLED. PENDING_PAYMENT is rejected until the Step 3 saga. */
@UseCase()
export class CancelOrderService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
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
    order.cancel({ now: this.clock.now(), changedBy: actorRef(actor) });
    await this.orders.save(order);
    await this.events.publishAll(order.pullEvents());
  }
}
