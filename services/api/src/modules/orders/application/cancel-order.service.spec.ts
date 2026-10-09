import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceRole } from '@shared/auth/workspace-role';
import { ConcurrencyError, StaleVersionError } from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import {
  LATER,
  ORDER,
  ORDER_REF,
  orderIn,
  sagaIn,
  USER,
  WORKSPACE,
} from '../domain/__test__/builders';
import {
  OrderInvalidTransitionError,
  OrderSagaNotFoundError,
  OrderSagaNotWaitingError,
} from '../domain/errors';
import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderSagaStep } from '../domain/order-saga-step';
import { OrderEventType, OrderStatus } from '../domain/order-status';

import { enableNoOpTransactions, fixedClock, member, tenantAs } from './__test__/fixtures';
import { InMemoryOrderSagasRepository } from './__test__/in-memory-order-sagas.repository';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { RecordingChargeScheduler } from './__test__/recording-charge-scheduler';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import {
  RecordingStockScheduler,
  RecordingTimeoutScheduler,
  TIMEOUT_AT,
} from './__test__/recording-saga-schedulers';
import { CancelOrderService } from './cancel-order.service';
import { OrderSagaSteps } from './order-saga-steps';
import { OrdersPolicy } from './orders.policy';

import type { Order, OrderHistoryEntry } from '../domain/order';

// The builders restore orders at version 3 and sagas at version 2, both for attempt 1.
const VERSION = 3;
const SAGA_VERSION = 2;
const PLACING = { workspaceId: WORKSPACE, orderId: ORDER, attempt: 1 };
const PAYMENT = { workspaceId: WORKSPACE, orderId: ORDER, paymentAttempt: 1 };
const cmd = { orderId: ORDER, version: VERSION };

/** A repository that also keeps the history its orders were saved with, like the table does. */
class OrdersWithHistory extends InMemoryOrdersRepository {
  readonly history: OrderHistoryEntry[] = [];

  override async save(order: Order): Promise<void> {
    await super.save(order);
    this.history.push(...order.pullHistory());
  }
}

describe('CancelOrderService', () => {
  let orders: OrdersWithHistory;
  let sagas: InMemoryOrderSagasRepository;
  let stock: RecordingStockScheduler;
  let charges: RecordingChargeScheduler;
  let timeouts: RecordingTimeoutScheduler;
  let events: RecordingEventPublisher;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new OrdersWithHistory();
    sagas = new InMemoryOrderSagasRepository();
    stock = new RecordingStockScheduler();
    charges = new RecordingChargeScheduler();
    timeouts = new RecordingTimeoutScheduler();
    events = new RecordingEventPublisher();
  });

  const cancelOrder = (role: WorkspaceRole = WorkspaceRole.Member): CancelOrderService =>
    new CancelOrderService(
      orders,
      new OrderSagaSteps(sagas, stock, charges, timeouts),
      new OrdersPolicy(),
      tenantAs(role),
      fixedClock,
      events,
    );

  /** An order that waits for attempt 1, and the saga of that attempt in `step`. */
  function waitingIn(step: OrderSagaStep, saga: Parameters<typeof sagaIn>[1] = {}): void {
    orders.put(orderIn(OrderStatus.PendingPayment));
    sagas.put(sagaIn(step, saga));
  }

  const saga = async () => (await sagas.getByAttempt(ORDER, 1)).snapshot();
  const order = async () => (await orders.getById(ORDER)).snapshot();

  function expectNothingSent(): void {
    expect(stock.released).toEqual([]);
    expect(charges.cancelled).toEqual([]);
    expect(timeouts.scheduled).toEqual([]);
    expect(events.published).toEqual([]);
  }

  describe('an order no saga is running for', () => {
    it.each([OrderStatus.Draft, OrderStatus.PaymentFailed])(
      'ORD-014 cancels an order in %s',
      async (status) => {
        orders.put(orderIn(status));

        await expect(cancelOrder().execute(cmd, member)).resolves.toBe('cancelled');

        const saved = await orders.getById(ORDER);
        expect(saved.status).toBe(OrderStatus.Cancelled);
        expect(saved.snapshot().cancelledAt).toEqual(LATER);
        expect(saved.version).toBe(VERSION + 1);
      },
    );

    it('OBX-007 publishes OrderCancelled', async () => {
      orders.put(orderIn(OrderStatus.Draft));

      await cancelOrder().execute(cmd, member);

      expect(events.published).toEqual([new OrderCancelled(ORDER_REF, LATER)]);
    });

    it('asks nothing of the other services: nothing is under way', async () => {
      orders.put(orderIn(OrderStatus.PaymentFailed));
      // the saga of the failed attempt, still releasing: not this cancellation's business
      sagas.put(sagaIn(OrderSagaStep.Releasing));

      await cancelOrder().execute(cmd, member);

      expect(stock.released).toEqual([]);
      expect(charges.cancelled).toEqual([]);
      expect(await saga()).toMatchObject({ step: OrderSagaStep.Releasing, version: SAGA_VERSION });
    });

    it.each([OrderStatus.Paid, OrderStatus.Fulfilled, OrderStatus.Cancelled])(
      'ORD-016 cannot cancel an order that is %s',
      async (status) => {
        orders.put(orderIn(status));

        await expect(cancelOrder().execute(cmd, member)).rejects.toThrow(
          OrderInvalidTransitionError,
        );

        expect((await orders.getById(ORDER)).status).toBe(status);
      },
    );
  });

  describe('SAGA-020 while the stock is being reserved', () => {
    it('cancels the order at once and publishes OrderCancelled', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await expect(cancelOrder().execute(cmd, member)).resolves.toBe('cancelled');

      expect(await order()).toMatchObject({
        status: OrderStatus.Cancelled,
        cancelledAt: LATER,
        version: VERSION + 1,
      });
      expect(events.published).toEqual([new OrderCancelled(ORDER_REF, LATER)]);
      expect(orders.history).toMatchObject([
        {
          type: OrderEventType.OrderCancelled,
          fromStatus: OrderStatus.PendingPayment,
          toStatus: OrderStatus.Cancelled,
          changedBy: USER,
        },
      ]);
    });

    it('releases in the dark and waits for the answer: the reservation may still arrive', async () => {
      waitingIn(OrderSagaStep.Reserving);

      await cancelOrder().execute(cmd, member);

      expect(stock.released).toEqual([PLACING]);
      expect(await saga()).toMatchObject({
        step: OrderSagaStep.Releasing,
        cancelRequestedAt: LATER,
        deadlineAt: TIMEOUT_AT,
      });
      expect(timeouts.scheduled).toEqual([{ ...PLACING, step: OrderSagaStep.Releasing }]);
      // no charge was asked for, so there is none to cancel
      expect(charges.cancelled).toEqual([]);
    });
  });

  describe('SAGA-021 while the charge is under way', () => {
    it('asks payments not to charge, and leaves the order waiting for its answer', async () => {
      waitingIn(OrderSagaStep.Charging);

      await expect(cancelOrder().execute(cmd, member)).resolves.toBe('requested');

      expect(charges.cancelled).toEqual([PAYMENT]);
      expect(await order()).toMatchObject({
        status: OrderStatus.PendingPayment,
        cancelledAt: null,
      });
      expect(await saga()).toMatchObject({
        step: OrderSagaStep.CancellingPayment,
        cancelRequestedAt: LATER,
        deadlineAt: TIMEOUT_AT,
      });
      expect(timeouts.scheduled).toEqual([{ ...PLACING, step: OrderSagaStep.CancellingPayment }]);
    });

    it('decides nothing yet: no release, no OrderCancelled', async () => {
      waitingIn(OrderSagaStep.Charging);

      await cancelOrder().execute(cmd, member);

      expect(stock.released).toEqual([]);
      expect(events.published).toEqual([]);
    });

    it('ORD-018 notes CANCELLATION_REQUESTED by the user in the history', async () => {
      waitingIn(OrderSagaStep.Charging);

      await cancelOrder().execute(cmd, member);

      expect(orders.history).toEqual([
        expect.objectContaining({
          type: OrderEventType.CancellationRequested,
          fromStatus: OrderStatus.PendingPayment,
          toStatus: OrderStatus.PendingPayment,
          changedBy: USER,
          payload: { paymentAttempt: 1 },
        }),
      ]);
    });
  });

  describe('SAGA-022 after a timeout has asked payments to cancel the charge', () => {
    it('remembers the request without asking payments a second time', async () => {
      waitingIn(OrderSagaStep.CancellingPayment);

      await expect(cancelOrder().execute(cmd, member)).resolves.toBe('requested');

      expect(await saga()).toMatchObject({
        step: OrderSagaStep.CancellingPayment,
        cancelRequestedAt: LATER,
        version: SAGA_VERSION + 1,
      });
      expect(charges.cancelled).toEqual([]);
      // the step did not begin again: its timeout is the one that is running
      expect(timeouts.scheduled).toEqual([]);
      expect(orders.history).toMatchObject([{ type: OrderEventType.CancellationRequested }]);
    });

    it('a second request writes nothing', async () => {
      waitingIn(OrderSagaStep.CancellingPayment, { cancelRequestedAt: LATER });

      await expect(cancelOrder().execute(cmd, member)).resolves.toBe('requested');

      expect(await saga()).toMatchObject({ version: SAGA_VERSION });
      expect(await order()).toMatchObject({ version: VERSION });
      expect(orders.history).toEqual([]);
      expectNothingSent();
    });
  });

  describe('SAGA-023 a request that is refused writes nothing', () => {
    it.each([OrderSagaStep.Reserving, OrderSagaStep.Charging])(
      'forbids a VIEWER while the saga is %s',
      async (step) => {
        waitingIn(step);

        await expect(cancelOrder(WorkspaceRole.Viewer).execute(cmd, member)).rejects.toThrow(
          ForbiddenError,
        );

        expect(await saga()).toMatchObject({ step, version: SAGA_VERSION });
        expect(await order()).toMatchObject({ version: VERSION });
        expectNothingSent();
      },
    );

    it('rejects a stale version', async () => {
      waitingIn(OrderSagaStep.Charging);

      await expect(
        cancelOrder().execute({ orderId: ORDER, version: VERSION - 1 }, member),
      ).rejects.toThrow(StaleVersionError);

      expect(await saga()).toMatchObject({ step: OrderSagaStep.Charging, version: SAGA_VERSION });
      expectNothingSent();
    });

    it('SAGA-012 sends nothing when an answer of the saga was handled at the same moment', async () => {
      waitingIn(OrderSagaStep.Charging);
      sagas.writeConcurrentlyAfterNextLoad();

      await expect(cancelOrder().execute(cmd, member)).rejects.toThrow(ConcurrencyError);

      expect(await order()).toMatchObject({ version: VERSION });
      expect(charges.cancelled).toEqual([]);
    });

    it('does not cancel an order whose saga is past the point (an answer is being handled)', async () => {
      waitingIn(OrderSagaStep.Completed);

      await expect(cancelOrder().execute(cmd, member)).rejects.toThrow(OrderSagaNotWaitingError);

      expect(await order()).toMatchObject({ status: OrderStatus.PendingPayment, version: VERSION });
      expectNothingSent();
    });

    it('reports a PENDING_PAYMENT order without a saga instead of cancelling it blindly', async () => {
      orders.put(orderIn(OrderStatus.PendingPayment));

      await expect(cancelOrder().execute(cmd, member)).rejects.toThrow(OrderSagaNotFoundError);

      expect(await order()).toMatchObject({ status: OrderStatus.PendingPayment });
    });
  });

  it('forbids a VIEWER and leaves a draft untouched', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await expect(cancelOrder(WorkspaceRole.Viewer).execute(cmd, member)).rejects.toThrow(
      ForbiddenError,
    );

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.Draft);
  });

  it('rejects a stale version of a draft', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await expect(
      cancelOrder().execute({ orderId: ORDER, version: VERSION - 1 }, member),
    ).rejects.toThrow(StaleVersionError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.Draft);
  });
});
