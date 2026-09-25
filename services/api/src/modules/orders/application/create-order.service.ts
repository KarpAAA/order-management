import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { TenantContext } from '@common/tenancy/tenant-context';
import { actorRef } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { discountOf } from '../domain/discount';
import { Order } from '../domain/order';
import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrderInputsReader } from './order-inputs.reader';
import { OrdersPolicy } from './orders.policy';

import type { CreateOrderCommand } from './order-commands';

@UseCase()
export class CreateOrderService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly policy: OrdersPolicy,
    private readonly tenant: TenantContext,
    private readonly inputs: OrderInputsReader,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  /**
   * No aggregate to load, so: policy → cross-module reads (outside the transaction) →
   * domain → insert. The currency and tax rate are snapshotted from the workspace.
   */
  async execute(cmd: CreateOrderCommand, actor: Actor): Promise<{ id: string }> {
    this.policy.assertCanWrite(actor, this.tenant.membership());
    const [terms, lines] = await Promise.all([
      this.inputs.workspaceTerms(cmd.workspaceId),
      this.inputs.lines(cmd.items),
    ]);
    const order = Order.draft({
      workspaceId: cmd.workspaceId,
      currency: terms.currency,
      taxRateBps: terms.taxRateBps,
      lines,
      ...(cmd.discount && { discount: discountOf(cmd.discount) }),
      createdBy: actorRef(actor),
      now: this.clock.now(),
    });
    await this.persist(order);
    return { id: order.id };
  }

  @Transactional()
  private async persist(order: Order): Promise<void> {
    await this.orders.insert(order);
    await this.events.publishAll(order.pullEvents());
  }
}
