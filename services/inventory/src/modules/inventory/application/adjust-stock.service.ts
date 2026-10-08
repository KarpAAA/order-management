import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';

import { StockItem } from '../domain/stock-item';
import {
  INVENTORY_EVENTS_PUBLISHER,
  type InventoryEventsPublisher,
} from '../ports/inventory-events-publisher.port';
import { STOCK_REPOSITORY, type StockRepositoryPort } from '../ports/stock-repository.port';

import { InventoryPolicy } from './inventory.policy';

import type { AdjustStockCommand } from './inventory-commands';

/**
 * Changes the stock on hand of a product by a difference, and answers with its levels.
 *
 * A difference and a locked row: the change is added to what the stock is now, so stock that
 * arrives while reservations are being made loses none of them. A product heard of for the
 * first time gets its stock item here; two commands that open the same product meet on its
 * primary key, and the refused one comes again.
 *
 * The same message twice would count the units twice, and no state says so: the inbox of the
 * consumer is what makes this command safe to deliver again.
 */
@Injectable()
export class AdjustStockService {
  constructor(
    @Inject(STOCK_REPOSITORY) private readonly stock: StockRepositoryPort,
    private readonly policy: InventoryPolicy,
    private readonly clock: Clock,
    @Inject(INVENTORY_EVENTS_PUBLISHER) private readonly publisher: InventoryEventsPublisher,
  ) {}

  @Transactional()
  async execute(cmd: AdjustStockCommand, actor: Actor): Promise<void> {
    this.policy.assertCanAdjust(actor);
    const now = this.clock.now();

    const locked = await this.stock.lockMany(cmd.workspaceId, [cmd.productId]);
    const existing = locked.get(cmd.productId);
    const item =
      existing ?? StockItem.open({ workspaceId: cmd.workspaceId, productId: cmd.productId, now });

    item.adjust(cmd.delta, now);

    if (existing) await this.stock.saveAll([item]);
    else await this.stock.insert(item);
    await this.publisher.stockAdjusted(item, cmd.correlationId);
  }
}
