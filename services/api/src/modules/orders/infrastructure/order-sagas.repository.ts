import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { ConcurrencyError } from '@shared/errors/domain-error';

import { OrderSagaNotFoundError } from '../domain/errors';

import { OrderSagaMapper, orderSagaSelect } from './order-saga.mapper';

import type { OrderSaga } from '../domain/order-saga';
import type { OrderSagasRepositoryPort } from '../ports/order-sagas-repository.port';

/**
 * Domain repository of the saga: domain objects in and out, through `txHost.tx`, which joins
 * the use case's `@Transactional()`. The tenant filter is added by the database layer, so a
 * lookup by order and attempt can never reach another workspace.
 */
@Injectable()
export class OrderSagasRepository implements OrderSagasRepositoryPort {
  constructor(private readonly txHost: TransactionHost<DbTransactionAdapter>) {}

  async findByAttempt(orderId: string, attempt: number): Promise<OrderSaga | null> {
    const row = await this.txHost.tx.orderSaga.findFirst({
      where: { orderId, attempt },
      select: orderSagaSelect,
    });
    return row ? OrderSagaMapper.toDomain(row) : null;
  }

  async getByAttempt(orderId: string, attempt: number): Promise<OrderSaga> {
    const saga = await this.findByAttempt(orderId, attempt);
    if (!saga) throw new OrderSagaNotFoundError(orderId, attempt);
    return saga;
  }

  async insert(saga: OrderSaga): Promise<void> {
    await this.txHost.tx.orderSaga.create({ data: OrderSagaMapper.toCreate(saga) });
  }

  /**
   * Optimistic lock: only the version we loaded may be overwritten. Two answers of one saga
   * handled at once both read the same step; the second save finds the version gone.
   */
  async save(saga: OrderSaga): Promise<void> {
    const { count } = await this.txHost.tx.orderSaga.updateMany({
      where: { orderId: saga.orderId, attempt: saga.attempt, version: saga.version },
      data: { ...OrderSagaMapper.toUpdate(saga), version: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConcurrencyError('OrderSaga', `${saga.orderId}:${String(saga.attempt)}`);
    }
  }
}
