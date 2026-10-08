// A fault in the worker's way to the database, for one order: what a restarting Postgres or a
// lost connection is to the use case. The repository of the running worker app is wrapped, so
// everything around the fault is the real path: consumer, tenant, transaction, broker.
import { vi } from 'vitest';

import {
  ORDERS_REPOSITORY,
  type OrdersRepositoryPort,
} from '@modules/orders/ports/orders-repository.port';

import type { WorkerApp } from './worker-app';

export const DATABASE_LOST = 'connection to the database lost';

/**
 * Makes the worker fail to load `orderId` the next `times` times (always, by default).
 * Returns the repair: after it the order loads again.
 */
export function failToLoad(worker: WorkerApp, orderId: string, times = Infinity): () => void {
  const orders = worker.get<OrdersRepositoryPort>(ORDERS_REPOSITORY);
  const load = orders.getById.bind(orders);
  let left = times;
  const fault = vi.spyOn(orders, 'getById').mockImplementation((id) => {
    if (id !== orderId || left <= 0) return load(id);
    left -= 1;
    return Promise.reject(new Error(DATABASE_LOST));
  });
  return () => {
    fault.mockRestore();
  };
}
