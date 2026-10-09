import type { Prisma, StockItem as StockItemRow } from '@infra/database/generated/prisma/client';

import { StockItem } from '../domain/stock-item';

export const StockMapper = {
  toDomain(row: StockItemRow): StockItem {
    return StockItem.restore({
      workspaceId: row.workspaceId,
      productId: row.productId,
      onHand: row.onHand,
      reserved: row.reserved,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  toCreate(item: StockItem): Prisma.StockItemUncheckedCreateInput {
    return { ...item.snapshot() };
  },

  /** The levels: the key and `created_at` never change. */
  toUpdate(item: StockItem): Prisma.StockItemUncheckedUpdateInput {
    const { onHand, reserved, updatedAt } = item.snapshot();
    return { onHand, reserved, updatedAt };
  },
};
