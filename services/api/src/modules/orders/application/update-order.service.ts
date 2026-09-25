import { Inject } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { UseCase } from '@common/decorators/use-case.decorator';
import { TenantContext } from '@common/tenancy/tenant-context';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '@shared/events/event-publisher';

import { discountOf } from '../domain/discount';
import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';

import { OrderInputsReader } from './order-inputs.reader';
import { OrdersPolicy } from './orders.policy';

import type { UpdateOrderCommand } from './order-commands';
import type { OrderLineInput } from '../domain/order';

/** Replaces items and discount of a DRAFT order. */
@UseCase()
export class UpdateOrderService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    private readonly policy: OrdersPolicy,
    private readonly tenant: TenantContext,
    private readonly inputs: OrderInputsReader,
    private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async execute(cmd: UpdateOrderCommand, actor: Actor): Promise<void> {
    // Role-only policy first; the catalog read happens before the transaction opens.
    this.policy.assertCanWrite(actor, this.tenant.membership());
    const lines = await this.inputs.lines(cmd.items);
    await this.apply(cmd, lines);
  }

  @Transactional()
  private async apply(cmd: UpdateOrderCommand, lines: OrderLineInput[]): Promise<void> {
    const order = await this.orders.getById(cmd.orderId);
    order.assertVersion(cmd.version);
    order.replaceContents({ lines, discount: discountOf(cmd.discount), now: this.clock.now() });
    await this.orders.save(order);
    await this.events.publishAll(order.pullEvents());
  }
}
