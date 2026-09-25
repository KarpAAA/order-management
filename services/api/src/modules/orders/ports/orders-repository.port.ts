import type { Order } from '../domain/order';

export const ORDERS_REPOSITORY = Symbol('ORDERS_REPOSITORY');

/** Level 4: `application/` depends on this port, `infrastructure/` implements it. */
export interface OrdersRepositoryPort {
  findById(id: string): Promise<Order | null>;
  /** Throws `OrderNotFoundError`. */
  getById(id: string): Promise<Order>;
  insert(order: Order): Promise<void>;
  /** Throws `ConcurrencyError` when the order changed since it was loaded. */
  save(order: Order): Promise<void>;
}
