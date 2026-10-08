import { StockItem } from '../stock-item';

import type { StockItemProps } from '../stock-item';

export const NOW = new Date('2026-10-09T10:00:00.000Z');
export const LATER = new Date('2026-10-09T10:05:00.000Z');

export const WORKSPACE_ID = '01990000-0000-7000-8000-a00000000000';
export const ORDER_ID = '01990000-0000-7000-8000-0d0000000001';
export const PRODUCT_A = '01990000-0000-7000-8000-a10000000001';
export const PRODUCT_B = '01990000-0000-7000-8000-a10000000002';

export const ATTEMPT = { workspaceId: WORKSPACE_ID, orderId: ORDER_ID, attempt: 1 };

export const stockItem = (overrides: Partial<StockItemProps> = {}): StockItem =>
  StockItem.restore({
    workspaceId: WORKSPACE_ID,
    productId: PRODUCT_A,
    onHand: 10,
    reserved: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

/** The stock of several products, keyed as a repository hands it to the domain. */
export const stockOf = (...items: StockItem[]): Map<string, StockItem> =>
  new Map(items.map((item) => [item.productId, item]));
