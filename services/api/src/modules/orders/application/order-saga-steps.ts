import { Inject, Injectable } from '@nestjs/common';

import type { Money } from '@shared/domain/money';

import { OrderSaga } from '../domain/order-saga';
import { OrderSagaStep } from '../domain/order-saga-step';
import {
  ORDER_SAGAS_REPOSITORY,
  type OrderSagasRepositoryPort,
} from '../ports/order-sagas-repository.port';
import {
  PAYMENT_CHARGE_SCHEDULER,
  type PaymentChargeScheduler,
} from '../ports/payment-charge-scheduler.port';
import {
  SAGA_TIMEOUT_SCHEDULER,
  type SagaTimeoutScheduler,
} from '../ports/saga-timeout-scheduler.port';
import {
  STOCK_RESERVATION_SCHEDULER,
  type StockReservationScheduler,
} from '../ports/stock-reservation-scheduler.port';

import type { Order } from '../domain/order';

/**
 * What every use case of the saga needs beside the order: the saga of the attempt, and the
 * three things a step can ask for (stock, a charge, its own timeout). One collaborator
 * instead of four ports in every constructor; no rule lives here. Which fact moves the saga
 * where is `OrderSaga`, what the order becomes is `Order`, and the order of the calls is the
 * use case's.
 *
 * Everything it sends is a row of the outbox, so it is called inside `@Transactional()`.
 */
@Injectable()
export class OrderSagaSteps {
  constructor(
    @Inject(ORDER_SAGAS_REPOSITORY) private readonly sagas: OrderSagasRepositoryPort,
    @Inject(STOCK_RESERVATION_SCHEDULER) private readonly stock: StockReservationScheduler,
    @Inject(PAYMENT_CHARGE_SCHEDULER) private readonly charges: PaymentChargeScheduler,
    @Inject(SAGA_TIMEOUT_SCHEDULER) private readonly timeouts: SagaTimeoutScheduler,
  ) {}

  /**
   * The saga of the attempt the order has just been placed as, in its first step: the stock
   * of the order is asked for, and the step has its timeout.
   */
  async start(order: Order, now: Date): Promise<void> {
    const placing = {
      workspaceId: order.workspaceId,
      orderId: order.id,
      attempt: order.paymentAttempt,
    };
    const deadline = await this.timeouts.schedule({ ...placing, step: OrderSagaStep.Reserving });
    await this.sagas.insert(OrderSaga.start({ ...placing, now, deadline }));
    await this.stock.reserve({
      ...placing,
      lines: order.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
    });
  }

  /** Throws `OrderSagaNotFoundError`. */
  getByAttempt(orderId: string, attempt: number): Promise<OrderSaga> {
    return this.sagas.getByAttempt(orderId, attempt);
  }

  /**
   * Saves the saga after it has accepted a fact. A step that has just begun to wait gets its
   * timeout here, and the saga its deadline: a step never waits without one, and a fact the
   * saga refused never gets this far, so it writes nothing.
   * Throws `ConcurrencyError` when another message of the saga was handled first.
   */
  async save(saga: OrderSaga): Promise<void> {
    const step = saga.waitingIn;
    if (step !== null && saga.deadlineAt === null) {
      const deadline = await this.timeouts.schedule({ ...this.placing(saga), step });
      saga.waitUntil(deadline);
    }
    await this.sagas.save(saga);
  }

  /**
   * "Charge this attempt." The command expires with the step that waits for it: after the
   * deadline of the saga payments charges nothing.
   */
  async charge(saga: OrderSaga, amount: Money): Promise<void> {
    const expiresAt = saga.deadlineAt;
    if (expiresAt === null) {
      throw new Error(`The saga of order ${saga.orderId} waits for nothing: no charge to ask for`);
    }
    await this.charges.schedule({ ...this.payment(saga), amount, expiresAt });
  }

  /** "Do not charge this attempt, and tell me how it ended." */
  cancelPayment(saga: OrderSaga): Promise<void> {
    return this.charges.cancel(this.payment(saga));
  }

  /** The compensation: "give back what this attempt holds", whether it holds anything or not. */
  releaseStock(saga: OrderSaga): Promise<void> {
    return this.stock.release(this.placing(saga));
  }

  private placing(saga: OrderSaga) {
    return { workspaceId: saga.workspaceId, orderId: saga.orderId, attempt: saga.attempt };
  }

  private payment(saga: OrderSaga) {
    return {
      workspaceId: saga.workspaceId,
      orderId: saga.orderId,
      paymentAttempt: saga.attempt,
    };
  }
}
