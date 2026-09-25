import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { ConcurrencyError } from '@shared/errors/domain-error';

import { OrderNotFoundError } from '../domain/errors';

import { OrderMapper, orderWithItemsInclude } from './order.mapper';

import type { Order } from '../domain/order';
import type { OrdersRepositoryPort } from '../ports/orders-repository.port';

/**
 * Domain repository: four methods, domain objects in and out. Writes go through `txHost.tx`,
 * which joins the use case's `@Transactional()`. The tenant filter is added by the database
 * layer, so a lookup by id can never reach another workspace.
 */
@Injectable()
export class OrdersRepository implements OrdersRepositoryPort {
  constructor(private readonly txHost: TransactionHost<DbTransactionAdapter>) {}

  async findById(id: string): Promise<Order | null> {
    const row = await this.txHost.tx.order.findFirst({
      where: { id },
      include: orderWithItemsInclude,
    });
    return row ? OrderMapper.toDomain(row) : null;
  }

  async getById(id: string): Promise<Order> {
    const order = await this.findById(id);
    if (!order) throw new OrderNotFoundError(id);
    return order;
  }

  async insert(order: Order): Promise<void> {
    await this.txHost.tx.order.create({ data: OrderMapper.toCreate(order) });
    await this.writeChildren(order);
  }

  /** Optimistic lock: only the version we loaded may be overwritten. */
  async save(order: Order): Promise<void> {
    const tx = this.txHost.tx;
    const { count } = await tx.order.updateMany({
      where: { id: order.id, version: order.version },
      data: { ...OrderMapper.toUpdate(order), version: { increment: 1 } },
    });
    if (count === 0) throw new ConcurrencyError('Order', order.id);

    // Lines are immutable: a removed line is deleted, a new one inserted, nothing updated.
    await tx.orderItem.deleteMany({
      where: { orderId: order.id, id: { notIn: order.lines.map((line) => line.id) } },
    });
    await this.writeChildren(order);
  }

  private async writeChildren(order: Order): Promise<void> {
    const tx = this.txHost.tx;
    const items = OrderMapper.toItemRows(order);
    if (items.length > 0) await tx.orderItem.createMany({ data: items, skipDuplicates: true });
    const events = OrderMapper.toEventRows(order, order.pullHistory());
    if (events.length > 0) await tx.orderEvent.createMany({ data: events });
  }
}
