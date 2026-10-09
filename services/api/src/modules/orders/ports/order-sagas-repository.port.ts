import type { OrderSaga } from '../domain/order-saga';

export const ORDER_SAGAS_REPOSITORY = Symbol('ORDER_SAGAS_REPOSITORY');

/** Level 4: `application/` depends on this port, `infrastructure/` implements it. */
export interface OrderSagasRepositoryPort {
  /** The saga of one placing of the order. */
  findByAttempt(orderId: string, attempt: number): Promise<OrderSaga | null>;
  /** Throws `OrderSagaNotFoundError`. */
  getByAttempt(orderId: string, attempt: number): Promise<OrderSaga>;
  insert(saga: OrderSaga): Promise<void>;
  /** Throws `ConcurrencyError` when the saga changed since it was loaded. */
  save(saga: OrderSaga): Promise<void>;
}
