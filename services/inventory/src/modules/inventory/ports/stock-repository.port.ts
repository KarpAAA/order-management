import type { StockItem } from '../domain/stock-item';

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

/**
 * The stock of products, for a use case that is about to change it.
 *
 * There is no plain read: whoever decides on a stock level must hold its row, or two
 * decisions are made on the same number and one of them is lost.
 */
export interface StockRepositoryPort {
  /**
   * The stock items of these products that exist, each locked until the transaction ends,
   * always in the same order of products: two use cases that want the same two products
   * wait for each other and never deadlock. Throws outside a transaction.
   */
  lockMany(workspaceId: string, productIds: readonly string[]): Promise<Map<string, StockItem>>;
  /** Throws `StockItemAlreadyExistsError` when another transaction opened the product first. */
  insert(item: StockItem): Promise<void>;
  /** Writes the levels of items this transaction has locked. */
  saveAll(items: readonly StockItem[]): Promise<void>;
}
