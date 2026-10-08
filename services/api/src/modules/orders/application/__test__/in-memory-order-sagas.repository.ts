import { ConcurrencyError } from '@shared/errors/domain-error';

import { OrderSagaNotFoundError } from '../../domain/errors';
import { OrderSaga } from '../../domain/order-saga';

import type { OrderSagaProps } from '../../domain/order-saga';
import type { OrderSagasRepositoryPort } from '../../ports/order-sagas-repository.port';

const key = (orderId: string, attempt: number): string => `${orderId}:${String(attempt)}`;

/**
 * Fake: a working `OrderSagasRepositoryPort` on a Map, with the contract of the Prisma one:
 * not found throws, `save` is an optimistic lock that bumps the version. Stores snapshots
 * and restores a fresh `OrderSaga` on every read, like a database would.
 */
export class InMemoryOrderSagasRepository implements OrderSagasRepositoryPort {
  private readonly rows = new Map<string, OrderSagaProps>();
  private concurrentWritePending = false;

  findByAttempt(orderId: string, attempt: number): Promise<OrderSaga | null> {
    const row = this.rows.get(key(orderId, attempt));
    const saga = row ? OrderSaga.restore({ ...row }) : null;
    if (row && this.concurrentWritePending) {
      this.concurrentWritePending = false;
      this.rows.set(key(orderId, attempt), { ...row, version: row.version + 1 });
    }
    return Promise.resolve(saga);
  }

  async getByAttempt(orderId: string, attempt: number): Promise<OrderSaga> {
    const saga = await this.findByAttempt(orderId, attempt);
    if (!saga) throw new OrderSagaNotFoundError(orderId, attempt);
    return saga;
  }

  insert(saga: OrderSaga): Promise<void> {
    this.put(saga);
    return Promise.resolve();
  }

  /** Mirrors the Prisma repository: only the loaded version may be overwritten. */
  save(saga: OrderSaga): Promise<void> {
    const id = key(saga.orderId, saga.attempt);
    if (this.rows.get(id)?.version !== saga.version) {
      return Promise.reject(new ConcurrencyError('OrderSaga', id));
    }
    this.rows.set(id, { ...saga.snapshot(), version: saga.version + 1 });
    return Promise.resolve();
  }

  /** Arrange: put a saga in the store as it is, without the version bump. */
  put(saga: OrderSaga): void {
    this.rows.set(key(saga.orderId, saga.attempt), { ...saga.snapshot() });
  }

  /** Assert: how many sagas are stored. */
  count(): number {
    return this.rows.size;
  }

  /**
   * Arrange: another message of the saga is handled right after the use case loads it, so
   * the use case's `save` hits the optimistic lock.
   */
  writeConcurrentlyAfterNextLoad(): void {
    this.concurrentWritePending = true;
  }
}
