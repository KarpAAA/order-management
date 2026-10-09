import { StockItemAlreadyExistsError } from '../../domain/errors';
import { StockItem } from '../../domain/stock-item';

import type { Journal } from './fixtures';
import type { StockRepositoryPort } from '../../ports/stock-repository.port';

/**
 * Fake: stock in a map. It hands out copies, as a database does: a change the use case does
 * not save is lost. Locks have no meaning in one thread; what is asked to be locked is
 * written to the journal, and the real ones are covered by the e2e suite.
 */
export class InMemoryStockRepository implements StockRepositoryPort {
  private readonly items = new Map<string, StockItem>();

  constructor(private readonly journal: Journal = []) {}

  put(...items: StockItem[]): void {
    for (const item of items) this.items.set(item.productId, item);
  }

  get(productId: string): StockItem | undefined {
    return this.items.get(productId);
  }

  lockMany(workspaceId: string, productIds: readonly string[]): Promise<Map<string, StockItem>> {
    this.journal.push(`lock stock ${[...productIds].sort().join(',')}`);
    const found = [...productIds].sort().flatMap((productId) => {
      const item = this.items.get(productId);
      return item?.workspaceId === workspaceId ? [StockItem.restore({ ...item.snapshot() })] : [];
    });
    return Promise.resolve(new Map(found.map((item) => [item.productId, item])));
  }

  insert(item: StockItem): Promise<void> {
    if (this.items.has(item.productId)) throw new StockItemAlreadyExistsError(item.productId);
    this.journal.push('insert stock');
    this.items.set(item.productId, item);
    return Promise.resolve();
  }

  saveAll(items: readonly StockItem[]): Promise<void> {
    this.journal.push('save stock');
    this.put(...items);
    return Promise.resolve();
  }
}
