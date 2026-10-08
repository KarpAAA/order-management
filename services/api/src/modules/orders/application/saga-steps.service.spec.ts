// The steps of the saga an answer or a timeout decides (SAGA-002…014), on in-memory ports:
// what each step does to the saga and to the order, what it sends, and what it leaves alone
// when the saga is not waiting for it. The domain rules are in domain/order-saga.spec.ts.
import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConcurrencyError } from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import {
  LATER,
  ORDER,
  orderIn,
  PRODUCT_1,
  sagaIn,
  SYSTEM_ACTOR,
  WORKSPACE,
} from '../domain/__test__/builders';
import {
  OrderSagaNotFoundError,
  OrderSagaNotWaitingError,
  PaymentAttemptNotPendingError,
} from '../domain/errors';
import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderPaid } from '../domain/events/order-paid.event';
import { OrderSagaStep } from '../domain/order-saga-step';
import { OrderEventType, OrderStatus } from '../domain/order-status';

import { enableNoOpTransactions, fixedClock, member, paymentConsumer } from './__test__/fixtures';
import { InMemoryOrderSagasRepository } from './__test__/in-memory-order-sagas.repository';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { RecordingChargeScheduler } from './__test__/recording-charge-scheduler';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import {
  RecordingStockScheduler,
  RecordingTimeoutScheduler,
  TIMEOUT_AT,
} from './__test__/recording-saga-schedulers';
import { CompleteOrderPaymentService } from './complete-order-payment.service';
import { ConfirmStockReleaseService } from './confirm-stock-release.service';
import { ConfirmStockReservationService } from './confirm-stock-reservation.service';
import { ExpireSagaStepService } from './expire-saga-step.service';
import { FailOrderPaymentService } from './fail-order-payment.service';
import { OrderSagaSteps } from './order-saga-steps';
import { OrdersPolicy } from './orders.policy';
import { RejectStockReservationService } from './reject-stock-reservation.service';

import type { OrderHistoryEntry } from '../domain/order';
import type { WaitingStep } from '../domain/order-saga-step';
import type { MockInstance } from 'vitest';

// The builders restore orders at version 3 and sagas at version 2, both for attempt 1.
const ORDER_VERSION = 3;
const SAGA_VERSION = 2;
const PLACING = { workspaceId: WORKSPACE, orderId: ORDER, attempt: 1 };
const PAYMENT = { workspaceId: WORKSPACE, orderId: ORDER, paymentAttempt: 1 };
const AMOUNT_DUE = orderIn(OrderStatus.PendingPayment).amountDue;

/** A repository that also keeps the history its orders were saved with, like the table does. */
class OrdersWithHistory extends InMemoryOrdersRepository {
  readonly history: OrderHistoryEntry[] = [];

  override async save(order: Parameters<InMemoryOrdersRepository['save']>[0]): Promise<void> {
    await super.save(order);
    this.history.push(...order.pullHistory());
  }
}

describe('the steps of the order saga', () => {
  let orders: OrdersWithHistory;
  let sagas: InMemoryOrderSagasRepository;
  let stock: RecordingStockScheduler;
  let charges: RecordingChargeScheduler;
  let timeouts: RecordingTimeoutScheduler;
  let events: RecordingEventPublisher;
  let logged: MockInstance<Logger['error']>;
  const policy = new OrdersPolicy();

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new OrdersWithHistory();
    sagas = new InMemoryOrderSagasRepository();
    stock = new RecordingStockScheduler();
    charges = new RecordingChargeScheduler();
    timeouts = new RecordingTimeoutScheduler();
    events = new RecordingEventPublisher();
    logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An order that waits for attempt 1, and the saga of that attempt in `step`. */
  function waitingIn(step: OrderSagaStep): void {
    orders.put(orderIn(OrderStatus.PendingPayment));
    sagas.put(sagaIn(step));
  }

  const saga = async () => (await sagas.getByAttempt(ORDER, 1)).snapshot();
  const order = async () => (await orders.getById(ORDER)).snapshot();

  /** Nothing was written and nothing was sent. */
  async function expectUntouched(step: OrderSagaStep, status = OrderStatus.PendingPayment) {
    expect(await saga()).toMatchObject({ step, version: SAGA_VERSION });
    expect(await order()).toMatchObject({ status, version: ORDER_VERSION });
    expect(orders.history).toEqual([]);
    expect(stock.reserved).toEqual([]);
    expect(stock.released).toEqual([]);
    expect(charges.scheduled).toEqual([]);
    expect(charges.cancelled).toEqual([]);
    expect(timeouts.scheduled).toEqual([]);
    expect(events.published).toEqual([]);
  }

  const steps = () => new OrderSagaSteps(sagas, stock, charges, timeouts);
  const confirmReservation = () =>
    new ConfirmStockReservationService(orders, steps(), policy, fixedClock);
  const rejectReservation = () =>
    new RejectStockReservationService(orders, steps(), policy, fixedClock, events);
  const completePayment = () =>
    new CompleteOrderPaymentService(orders, steps(), policy, fixedClock, events);
  const failPayment = () =>
    new FailOrderPaymentService(orders, steps(), policy, fixedClock, events);
  const confirmRelease = () => new ConfirmStockReleaseService(orders, steps(), policy, fixedClock);
  const expireStep = () => new ExpireSagaStepService(orders, steps(), policy, fixedClock, events);

  describe('ConfirmStockReservationService', () => {
    const cmd = { orderId: ORDER, attempt: 1 };

    it('SAGA-002 moves the saga to CHARGING, with the deadline of its timeout', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await confirmReservation().execute(cmd, paymentConsumer);

      expect(await saga()).toMatchObject({
        step: OrderSagaStep.Charging,
        deadlineAt: TIMEOUT_AT,
        updatedAt: LATER,
        version: SAGA_VERSION + 1,
      });
      expect(timeouts.scheduled).toEqual([{ ...PLACING, step: OrderSagaStep.Charging }]);
    });

    it('SAGA-002 PAY-001 asks for the charge of the amount due, which expires with the step', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await confirmReservation().execute(cmd, paymentConsumer);

      expect(charges.scheduled).toEqual([
        { ...PAYMENT, amount: AMOUNT_DUE, expiresAt: TIMEOUT_AT },
      ]);
      expect(charges.cancelled).toEqual([]);
    });

    it('SAGA-002 ORD-018 leaves the order PENDING_PAYMENT and notes STOCK_RESERVED in its history', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await confirmReservation().execute(cmd, paymentConsumer);

      expect(await order()).toMatchObject({
        status: OrderStatus.PendingPayment,
        version: ORDER_VERSION + 1,
      });
      expect(orders.history).toEqual([
        expect.objectContaining({
          type: OrderEventType.StockReserved,
          fromStatus: OrderStatus.PendingPayment,
          toStatus: OrderStatus.PendingPayment,
          changedBy: SYSTEM_ACTOR,
          payload: { paymentAttempt: 1 },
        }),
      ]);
    });

    it.each([
      OrderSagaStep.Charging,
      OrderSagaStep.CancellingPayment,
      OrderSagaStep.Releasing,
      OrderSagaStep.Completed,
      OrderSagaStep.Aborted,
    ])('SAGA-011 asks for no second charge when the saga is %s', async (step) => {
      waitingIn(step);

      await expect(confirmReservation().execute(cmd, paymentConsumer)).rejects.toThrow(
        OrderSagaNotWaitingError,
      );

      await expectUntouched(step);
    });

    it('SAGA-011 an answer for an earlier attempt finds the saga of that attempt, not the new one', async () => {
      orders.put(orderIn(OrderStatus.PendingPayment, { paymentAttempt: 2 }));
      sagas.put(sagaIn(OrderSagaStep.Aborted));
      sagas.put(sagaIn(OrderSagaStep.Reserving, { attempt: 2 }));

      await expect(confirmReservation().execute(cmd, paymentConsumer)).rejects.toThrow(
        OrderSagaNotWaitingError,
      );

      expect((await sagas.getByAttempt(ORDER, 2)).step).toBe(OrderSagaStep.Reserving);
      expect(charges.scheduled).toEqual([]);
    });

    it('SAGA-013 reports an attempt that has no saga as not found', async () => {
      orders.put(orderIn(OrderStatus.PendingPayment));

      await expect(confirmReservation().execute(cmd, paymentConsumer)).rejects.toThrow(
        OrderSagaNotFoundError,
      );
    });

    it('SAGA-012 writes nothing when another message of the saga was handled first', async () => {
      waitingIn(OrderSagaStep.Reserving);
      sagas.writeConcurrentlyAfterNextLoad();

      await expect(confirmReservation().execute(cmd, paymentConsumer)).rejects.toThrow(
        ConcurrencyError,
      );

      expect(charges.scheduled).toEqual([]);
      expect(await order()).toMatchObject({ version: ORDER_VERSION });
    });

    it('SAGA-014 a user calling it directly cannot move the saga', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await expect(confirmReservation().execute(cmd, member)).rejects.toThrow(ForbiddenError);

      await expectUntouched(OrderSagaStep.Reserving);
    });
  });

  describe('RejectStockReservationService', () => {
    const shortages = [{ productId: PRODUCT_1, requested: 3, available: 1 }];
    const cmd = { orderId: ORDER, attempt: 1, shortages };

    it('SAGA-003 ends the saga and gives the order back as a DRAFT, with the reason', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await rejectReservation().execute(cmd, paymentConsumer);

      expect(await saga()).toMatchObject({ step: OrderSagaStep.Aborted, deadlineAt: null });
      expect(await order()).toMatchObject({
        status: OrderStatus.Draft,
        failureReason: 'out_of_stock',
        placedAt: null,
        version: ORDER_VERSION + 1,
      });
      expect(orders.history).toEqual([
        expect.objectContaining({
          type: OrderEventType.StockReservationFailed,
          fromStatus: OrderStatus.PendingPayment,
          toStatus: OrderStatus.Draft,
          payload: { paymentAttempt: 1, reason: 'out_of_stock', shortages },
        }),
      ]);
    });

    it('SAGA-003 compensates nothing: no charge, no release, no timeout', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await rejectReservation().execute(cmd, paymentConsumer);

      expect(charges.scheduled).toEqual([]);
      expect(stock.released).toEqual([]);
      expect(timeouts.scheduled).toEqual([]);
      expect(events.published).toEqual([]);
    });

    it('SAGA-011 does not take back an order whose stock was reserved meanwhile', async () => {
      waitingIn(OrderSagaStep.Charging);

      await expect(rejectReservation().execute(cmd, paymentConsumer)).rejects.toThrow(
        OrderSagaNotWaitingError,
      );

      await expectUntouched(OrderSagaStep.Charging);
    });

    it('SAGA-014 a user calling it directly cannot move the saga', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await expect(rejectReservation().execute(cmd, member)).rejects.toThrow(ForbiddenError);

      await expectUntouched(OrderSagaStep.Reserving);
    });
  });

  describe('CompleteOrderPaymentService', () => {
    const cmd = { orderId: ORDER, paymentAttempt: 1, pspChargeId: 'ch_1' };

    it('SAGA-021 pays an order the user asked to cancel: the charge was made first', async () => {
      orders.put(orderIn(OrderStatus.PendingPayment));
      sagas.put(sagaIn(OrderSagaStep.CancellingPayment, { cancelRequestedAt: LATER }));

      await completePayment().execute(cmd, paymentConsumer);

      expect(await order()).toMatchObject({ status: OrderStatus.Paid, cancelledAt: null });
      expect(await saga()).toMatchObject({ step: OrderSagaStep.Completed });
      expect(stock.released).toEqual([]);
    });

    it.each([OrderSagaStep.Charging, OrderSagaStep.CancellingPayment])(
      'SAGA-004 PAY-004 marks the order PAID and ends the saga that was %s',
      async (step) => {
        waitingIn(step);

        await completePayment().execute(cmd, paymentConsumer);

        expect(await order()).toMatchObject({
          status: OrderStatus.Paid,
          pspChargeId: 'ch_1',
          paidAt: LATER,
        });
        expect(await saga()).toMatchObject({ step: OrderSagaStep.Completed, deadlineAt: null });
      },
    );

    it('OBX-007 publishes OrderPaid for the attempt, with the charge id', async () => {
      waitingIn(OrderSagaStep.Charging);

      await completePayment().execute(cmd, paymentConsumer);

      expect(events.published).toEqual([new OrderPaid(WORKSPACE, ORDER, 1, 'ch_1', LATER)]);
    });

    it('SAGA-004 sends nothing: after the charge there is nothing to compensate', async () => {
      waitingIn(OrderSagaStep.Charging);

      await completePayment().execute(cmd, paymentConsumer);

      expect(stock.released).toEqual([]);
      expect(timeouts.scheduled).toEqual([]);
    });

    it('SAGA-011 does not pay an order whose stock is not reserved yet', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await expect(completePayment().execute(cmd, paymentConsumer)).rejects.toThrow(
        OrderSagaNotWaitingError,
      );

      await expectUntouched(OrderSagaStep.Reserving);
    });

    it('PAY-009 refuses the outcome of an attempt the order is not waiting for', async () => {
      orders.put(orderIn(OrderStatus.PendingPayment, { paymentAttempt: 2 }));
      sagas.put(sagaIn(OrderSagaStep.Aborted));

      await expect(completePayment().execute(cmd, paymentConsumer)).rejects.toThrow(
        PaymentAttemptNotPendingError,
      );
    });

    // PaymentEventsConsumer always passes its own system actor, so this
    // use case's own check is only exercised when it is called directly.
    it('PAY-013 a user calling it directly cannot mark the order paid', async () => {
      waitingIn(OrderSagaStep.Charging);

      await expect(completePayment().execute(cmd, member)).rejects.toThrow(ForbiddenError);

      await expectUntouched(OrderSagaStep.Charging);
    });
  });

  describe('FailOrderPaymentService', () => {
    const cmd = { orderId: ORDER, paymentAttempt: 1, reason: 'card_declined' };

    it.each([OrderSagaStep.Charging, OrderSagaStep.CancellingPayment])(
      'SAGA-005 PAY-005 marks the order PAYMENT_FAILED with the reason when the saga was %s',
      async (step) => {
        waitingIn(step);

        await failPayment().execute(cmd, paymentConsumer);

        expect(await order()).toMatchObject({
          status: OrderStatus.PaymentFailed,
          failureReason: 'card_declined',
        });
      },
    );

    it('SAGA-005 compensates: the stock of the attempt is released, with the timeout of the step', async () => {
      waitingIn(OrderSagaStep.Charging);

      await failPayment().execute(cmd, paymentConsumer);

      expect(await saga()).toMatchObject({
        step: OrderSagaStep.Releasing,
        deadlineAt: TIMEOUT_AT,
      });
      expect(stock.released).toEqual([PLACING]);
      expect(timeouts.scheduled).toEqual([{ ...PLACING, step: OrderSagaStep.Releasing }]);
      expect(charges.cancelled).toEqual([]);
    });

    it.each([
      ['declined', 'card_declined'],
      ['cancelled by payments', 'payment_timeout'],
    ])(
      'SAGA-021 ends the order CANCELLED when the user had asked for it and the charge was %s',
      async (_case, reason) => {
        orders.put(orderIn(OrderStatus.PendingPayment));
        sagas.put(sagaIn(OrderSagaStep.CancellingPayment, { cancelRequestedAt: LATER }));

        await failPayment().execute({ ...cmd, reason }, paymentConsumer);

        expect(await order()).toMatchObject({
          status: OrderStatus.Cancelled,
          cancelledAt: LATER,
          // not a failure of the payment: the user got what they asked for
          failureReason: null,
        });
        expect(events.published).toEqual([new OrderCancelled(WORKSPACE, ORDER, LATER)]);
        expect(orders.history).toMatchObject([
          {
            type: OrderEventType.OrderCancelled,
            fromStatus: OrderStatus.PendingPayment,
            toStatus: OrderStatus.Cancelled,
            changedBy: SYSTEM_ACTOR,
          },
        ]);
        // the stock goes back either way
        expect(stock.released).toEqual([PLACING]);
        expect(await saga()).toMatchObject({ step: OrderSagaStep.Releasing });
      },
    );

    it('SAGA-022 a timeout alone does not cancel: the order is PAYMENT_FAILED with payment_timeout', async () => {
      waitingIn(OrderSagaStep.CancellingPayment);

      await failPayment().execute({ ...cmd, reason: 'payment_timeout' }, paymentConsumer);

      expect(await order()).toMatchObject({
        status: OrderStatus.PaymentFailed,
        failureReason: 'payment_timeout',
      });
      expect(events.published).toEqual([]);
    });

    it('SAGA-011 releases nothing twice: a second failure finds the saga RELEASING', async () => {
      waitingIn(OrderSagaStep.Charging);
      await failPayment().execute(cmd, paymentConsumer);

      await expect(failPayment().execute(cmd, paymentConsumer)).rejects.toThrow(
        PaymentAttemptNotPendingError,
      );

      expect(stock.released).toHaveLength(1);
    });

    it('SAGA-011 does not fail an order whose stock is not reserved yet', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await expect(failPayment().execute(cmd, paymentConsumer)).rejects.toThrow(
        OrderSagaNotWaitingError,
      );

      await expectUntouched(OrderSagaStep.Reserving);
    });

    it('PAY-013 a user calling it directly cannot fail the payment', async () => {
      waitingIn(OrderSagaStep.Charging);

      await expect(failPayment().execute(cmd, member)).rejects.toThrow(ForbiddenError);

      await expectUntouched(OrderSagaStep.Charging);
    });
  });

  describe('ConfirmStockReleaseService', () => {
    const cmd = { orderId: ORDER, attempt: 1 };

    it('SAGA-006 ends the saga and notes STOCK_RELEASED, without moving the order', async () => {
      orders.put(orderIn(OrderStatus.PaymentFailed));
      sagas.put(sagaIn(OrderSagaStep.Releasing));

      await confirmRelease().execute(cmd, paymentConsumer);

      expect(await saga()).toMatchObject({ step: OrderSagaStep.Aborted, deadlineAt: null });
      expect(await order()).toMatchObject({
        status: OrderStatus.PaymentFailed,
        failureReason: 'card_declined',
      });
      expect(orders.history).toEqual([
        expect.objectContaining({
          type: OrderEventType.StockReleased,
          fromStatus: OrderStatus.PaymentFailed,
          toStatus: OrderStatus.PaymentFailed,
          payload: { paymentAttempt: 1 },
        }),
      ]);
    });

    it('SAGA-006 notes the release of an earlier attempt on an order that was placed again', async () => {
      orders.put(orderIn(OrderStatus.PendingPayment, { paymentAttempt: 2 }));
      sagas.put(sagaIn(OrderSagaStep.Releasing));
      sagas.put(sagaIn(OrderSagaStep.Reserving, { attempt: 2 }));

      await confirmRelease().execute(cmd, paymentConsumer);

      expect(await order()).toMatchObject({ status: OrderStatus.PendingPayment });
      expect((await sagas.getByAttempt(ORDER, 2)).step).toBe(OrderSagaStep.Reserving);
      expect(orders.history).toMatchObject([{ payload: { paymentAttempt: 1 } }]);
    });

    it.each([OrderSagaStep.Reserving, OrderSagaStep.Charging, OrderSagaStep.Aborted])(
      'SAGA-011 ignores a release nobody asked for while the saga is %s',
      async (step) => {
        waitingIn(step);

        await expect(confirmRelease().execute(cmd, paymentConsumer)).rejects.toThrow(
          OrderSagaNotWaitingError,
        );

        await expectUntouched(step);
      },
    );

    it('SAGA-014 a user calling it directly cannot move the saga', async () => {
      waitingIn(OrderSagaStep.Releasing);

      await expect(confirmRelease().execute(cmd, member)).rejects.toThrow(ForbiddenError);

      await expectUntouched(OrderSagaStep.Releasing);
    });
  });

  describe('ExpireSagaStepService', () => {
    const timeoutOf = (step: WaitingStep) => ({ orderId: ORDER, attempt: 1, step });

    it('SAGA-007 gives up a reservation that was never answered: DRAFT, and a release in the dark', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await expireStep().execute(timeoutOf(OrderSagaStep.Reserving), paymentConsumer);

      expect(await order()).toMatchObject({
        status: OrderStatus.Draft,
        failureReason: 'inventory_unavailable',
        placedAt: null,
      });
      expect(await saga()).toMatchObject({
        step: OrderSagaStep.Releasing,
        deadlineAt: TIMEOUT_AT,
      });
      expect(stock.released).toEqual([PLACING]);
      expect(timeouts.scheduled).toEqual([{ ...PLACING, step: OrderSagaStep.Releasing }]);
      expect(charges.scheduled).toEqual([]);
      expect(orders.history).toMatchObject([
        {
          type: OrderEventType.StockReservationFailed,
          payload: { paymentAttempt: 1, reason: 'inventory_unavailable' },
        },
      ]);
    });

    it('SAGA-008 decides nothing about a charge that was not answered: asks payments to cancel it', async () => {
      waitingIn(OrderSagaStep.Charging);

      await expireStep().execute(timeoutOf(OrderSagaStep.Charging), paymentConsumer);

      expect(await order()).toMatchObject({ status: OrderStatus.PendingPayment });
      expect(await saga()).toMatchObject({
        step: OrderSagaStep.CancellingPayment,
        deadlineAt: TIMEOUT_AT,
      });
      expect(charges.cancelled).toEqual([PAYMENT]);
      expect(stock.released).toEqual([]);
      expect(timeouts.scheduled).toEqual([{ ...PLACING, step: OrderSagaStep.CancellingPayment }]);
      expect(orders.history).toEqual([
        expect.objectContaining({
          type: OrderEventType.PaymentTimedOut,
          fromStatus: OrderStatus.PendingPayment,
          toStatus: OrderStatus.PendingPayment,
          changedBy: SYSTEM_ACTOR,
          payload: { paymentAttempt: 1 },
        }),
      ]);
    });

    it('SAGA-009 asks payments again when the cancellation was not answered, and says so', async () => {
      waitingIn(OrderSagaStep.CancellingPayment);

      await expireStep().execute(timeoutOf(OrderSagaStep.CancellingPayment), paymentConsumer);

      expect(await saga()).toMatchObject({
        step: OrderSagaStep.CancellingPayment,
        deadlineAt: TIMEOUT_AT,
        version: SAGA_VERSION + 1,
      });
      expect(charges.cancelled).toEqual([PAYMENT]);
      expect(timeouts.scheduled).toEqual([{ ...PLACING, step: OrderSagaStep.CancellingPayment }]);
      // nothing about the order: it is still waiting, and its history has nothing new to say
      expect(await order()).toMatchObject({
        status: OrderStatus.PendingPayment,
        version: ORDER_VERSION,
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(ORDER));
    });

    it('SAGA-009 asks inventory again when the release was not confirmed, and says so', async () => {
      orders.put(orderIn(OrderStatus.PaymentFailed));
      sagas.put(sagaIn(OrderSagaStep.Releasing));

      await expireStep().execute(timeoutOf(OrderSagaStep.Releasing), paymentConsumer);

      expect(await saga()).toMatchObject({ step: OrderSagaStep.Releasing, deadlineAt: TIMEOUT_AT });
      expect(stock.released).toEqual([PLACING]);
      expect(timeouts.scheduled).toEqual([{ ...PLACING, step: OrderSagaStep.Releasing }]);
      expect(await order()).toMatchObject({
        status: OrderStatus.PaymentFailed,
        version: ORDER_VERSION,
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(ORDER));
    });

    it.each([
      { timeout: OrderSagaStep.Reserving, step: OrderSagaStep.Charging },
      { timeout: OrderSagaStep.Charging, step: OrderSagaStep.Completed },
      { timeout: OrderSagaStep.Charging, step: OrderSagaStep.Releasing },
      { timeout: OrderSagaStep.CancellingPayment, step: OrderSagaStep.Completed },
      { timeout: OrderSagaStep.Releasing, step: OrderSagaStep.Aborted },
    ] as const)(
      'SAGA-010 the timeout of $timeout changes nothing once the saga is $step',
      async ({ timeout, step }) => {
        waitingIn(step);

        await expect(expireStep().execute(timeoutOf(timeout), paymentConsumer)).rejects.toThrow(
          OrderSagaNotWaitingError,
        );

        await expectUntouched(step);
        expect(logged).not.toHaveBeenCalled();
      },
    );

    it('SAGA-012 writes nothing when the answer was handled at the same moment', async () => {
      waitingIn(OrderSagaStep.Charging);
      sagas.writeConcurrentlyAfterNextLoad();

      await expect(
        expireStep().execute(timeoutOf(OrderSagaStep.Charging), paymentConsumer),
      ).rejects.toThrow(ConcurrencyError);

      expect(charges.cancelled).toEqual([]);
      expect(await order()).toMatchObject({ version: ORDER_VERSION });
    });

    it('SAGA-014 a user calling it directly cannot move the saga', async () => {
      waitingIn(OrderSagaStep.Charging);

      await expect(expireStep().execute(timeoutOf(OrderSagaStep.Charging), member)).rejects.toThrow(
        ForbiddenError,
      );

      await expectUntouched(OrderSagaStep.Charging);
    });
  });
});
