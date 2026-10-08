import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import type { StockItem as StockItemRow } from '@infra/database/generated/prisma/client';
import { isUniqueViolation } from '@infra/database/prisma-errors';
import type { DbTransactionAdapter } from '@infra/database/transactional.adapter';

import { StockItemAlreadyExistsError } from '../domain/errors';

import { StockMapper } from './stock.mapper';

import type { StockItem } from '../domain/stock-item';
import type { StockRepositoryPort } from '../ports/stock-repository.port';

/**
 * Stock items, read only to be changed: every read takes the lock of its rows.
 *
 * `FOR UPDATE` makes the second transaction that wants a row wait for the first to end, and
 * then read the row as the first left it. `ORDER BY product_id` is what keeps two
 * transactions that want the same rows from waiting for each other forever: rows are locked
 * in the order they are returned, and that order is the same for everybody.
 */
@Injectable()
export class StockRepository implements StockRepositoryPort {
  constructor(private readonly txHost: TransactionHost<DbTransactionAdapter>) {}

  async lockMany(
    workspaceId: string,
    productIds: readonly string[],
  ): Promise<Map<string, StockItem>> {
    if (!this.txHost.isTransactionActive()) {
      // outside a transaction the lock is gone when the statement ends: a lock in name only
      throw new Error('StockRepository.lockMany() must be called inside a transaction');
    }
    if (productIds.length === 0) return new Map();

    const rows = await this.txHost.tx.$queryRaw<StockItemRow[]>`
      SELECT workspace_id AS "workspaceId",
             product_id   AS "productId",
             on_hand      AS "onHand",
             reserved,
             created_at   AS "createdAt",
             updated_at   AS "updatedAt"
        FROM stock_items
       WHERE workspace_id = ${workspaceId}::uuid
         AND product_id = ANY(${[...productIds]}::uuid[])
       ORDER BY product_id
         FOR UPDATE`;
    return new Map(rows.map((row) => [row.productId, StockMapper.toDomain(row)]));
  }

  async insert(item: StockItem): Promise<void> {
    try {
      await this.txHost.tx.stockItem.create({ data: StockMapper.toCreate(item) });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new StockItemAlreadyExistsError(item.productId);
      throw err;
    }
  }

  async saveAll(items: readonly StockItem[]): Promise<void> {
    for (const item of items) {
      await this.txHost.tx.stockItem.update({
        where: {
          workspaceId_productId: { workspaceId: item.workspaceId, productId: item.productId },
        },
        data: StockMapper.toUpdate(item),
      });
    }
  }
}
