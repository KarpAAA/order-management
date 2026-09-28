import { ConcurrencyError } from '@shared/errors/domain-error';

import { OrderNotFoundError } from '../../domain/errors';
import { Order } from '../../domain/order';

import type { OrderProps } from '../../domain/order';
import type { OrdersRepositoryPort } from '../../ports/orders-repository.port';

/**
 * Fake: a working `OrdersRepositoryPort` on a Map. Keeps the port's contract — not found
 * throws, `save` is an optimistic lock that bumps the version — so a use-case test fails
 * when the use case breaks that contract, not only when the fake is told to fail.
 * Stores snapshots and restores a fresh `Order` on every read, like a database would.
 */
export class InMemoryOrdersRepository implements OrdersRepositoryPort {
  private readonly rows = new Map<string, OrderProps>();
  private concurrentWritePending = false;

  findById(id: string): Promise<Order | null> {
    const row = this.rows.get(id);
    const order = row ? Order.restore({ ...row }) : null;
    if (order && this.concurrentWritePending) {
      this.concurrentWritePending = false;
      this.bumpVersion(id);
    }
    return Promise.resolve(order);
  }

  async getById(id: string): Promise<Order> {
    const order = await this.findById(id);
    if (!order) throw new OrderNotFoundError(id);
    return order;
  }

  insert(order: Order): Promise<void> {
    this.rows.set(order.id, { ...order.snapshot() });
    return Promise.resolve();
  }

  /** Mirrors the Prisma repository: only the loaded version may be overwritten. */
  save(order: Order): Promise<void> {
    const stored = this.rows.get(order.id);
    if (stored?.version !== order.version) {
      return Promise.reject(new ConcurrencyError('Order', order.id));
    }
    this.rows.set(order.id, { ...order.snapshot(), version: order.version + 1 });
    return Promise.resolve();
  }

  /** Arrange: put an order in the store as it is, without the version bump. */
  put(order: Order): void {
    this.rows.set(order.id, { ...order.snapshot() });
  }

  /**
   * Arrange: another writer saves the order right after the use case loads it, so the
   * use case's `save` hits the optimistic lock.
   */
  writeConcurrentlyAfterNextLoad(): void {
    this.concurrentWritePending = true;
  }

  private bumpVersion(id: string): void {
    const stored = this.rows.get(id);
    if (stored) this.rows.set(id, { ...stored, version: stored.version + 1 });
  }
}
