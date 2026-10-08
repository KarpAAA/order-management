import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceRole } from '@shared/auth/workspace-role';
import { ConcurrencyError, StaleVersionError } from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { LATER, ORDER, orderIn, PRODUCT_1, WORKSPACE } from '../domain/__test__/builders';
import {
  OrderHasNoItemsError,
  OrderInvalidTransitionError,
  OrderNotFoundError,
} from '../domain/errors';
import { OrderPlaced } from '../domain/events/order-placed.event';
import { OrderSagaStep } from '../domain/order-saga-step';
import { OrderStatus } from '../domain/order-status';

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
import { OrderSagaSteps } from './order-saga-steps';
import { OrdersPolicy } from './orders.policy';
import { PlaceOrderService } from './place-order.service';

// The builders restore orders at version 3.
const VERSION = 3;
// every order of the builders has the same lines, so the same amount to charge
const AMOUNT_DUE = orderIn(OrderStatus.Draft).amountDue;

describe('PlaceOrderService', () => {
  let orders: InMemoryOrdersRepository;
  let sagas: InMemoryOrderSagasRepository;
  let stock: RecordingStockScheduler;
  let timeouts: RecordingTimeoutScheduler;
  let events: RecordingEventPublisher;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new InMemoryOrdersRepository();
    sagas = new InMemoryOrderSagasRepository();
    stock = new RecordingStockScheduler();
    timeouts = new RecordingTimeoutScheduler();
    events = new RecordingEventPublisher();
  });

  const placeOrder = (role: WorkspaceRole = WorkspaceRole.Member): PlaceOrderService =>
    new PlaceOrderService(
      orders,
      new OrderSagaSteps(sagas, stock, new RecordingChargeScheduler(), timeouts),
      new OrdersPolicy(),
      tenantAs(role),
      fixedClock,
      events,
    );

  it('moves a draft to PENDING_PAYMENT as payment attempt 1', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await placeOrder().execute({ orderId: ORDER, version: VERSION }, member);

    const saved = await orders.getById(ORDER);
    expect(saved.status).toBe(OrderStatus.PendingPayment);
    expect(saved.paymentAttempt).toBe(1);
    expect(saved.snapshot().placedAt).toEqual(LATER);
    expect(saved.version).toBe(VERSION + 1);
  });

  it('publishes OrderPlaced for the new payment attempt, with the amount to charge', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await placeOrder().execute({ orderId: ORDER, version: VERSION }, member);

    expect(events.published).toEqual([new OrderPlaced(WORKSPACE, ORDER, 1, AMOUNT_DUE, LATER)]);
  });

  it('SAGA-001 starts the saga of the attempt in RESERVING, with the deadline of its timeout', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await placeOrder().execute({ orderId: ORDER, version: VERSION }, member);

    expect((await sagas.getByAttempt(ORDER, 1)).snapshot()).toEqual({
      workspaceId: WORKSPACE,
      orderId: ORDER,
      attempt: 1,
      step: OrderSagaStep.Reserving,
      deadlineAt: TIMEOUT_AT,
      version: 0,
      createdAt: LATER,
      updatedAt: LATER,
    });
  });

  it('SAGA-001 asks inventory for the lines of the order, and writes the timeout of the step', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await placeOrder().execute({ orderId: ORDER, version: VERSION }, member);

    const placing = { workspaceId: WORKSPACE, orderId: ORDER, attempt: 1 };
    expect(stock.reserved).toEqual([
      { ...placing, lines: [{ productId: PRODUCT_1, quantity: 1 }] },
    ]);
    expect(stock.released).toEqual([]);
    expect(timeouts.scheduled).toEqual([{ ...placing, step: OrderSagaStep.Reserving }]);
  });

  it('re-places an order whose payment failed as the next attempt, with a saga of its own', async () => {
    orders.put(orderIn(OrderStatus.PaymentFailed));

    await placeOrder().execute({ orderId: ORDER, version: VERSION }, member);

    const saved = await orders.getById(ORDER);
    expect(saved.status).toBe(OrderStatus.PendingPayment);
    expect(saved.paymentAttempt).toBe(2);
    expect((await sagas.getByAttempt(ORDER, 2)).step).toBe(OrderSagaStep.Reserving);
    expect(stock.reserved).toMatchObject([{ orderId: ORDER, attempt: 2 }]);
    expect(events.published).toEqual([new OrderPlaced(WORKSPACE, ORDER, 2, AMOUNT_DUE, LATER)]);
  });

  it('forbids a VIEWER and leaves the order untouched', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await expect(
      placeOrder(WorkspaceRole.Viewer).execute({ orderId: ORDER, version: VERSION }, member),
    ).rejects.toThrow(ForbiddenError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.Draft);
    expect(sagas.count()).toBe(0);
    expect(events.published).toEqual([]);
  });

  it('rejects a stale version and publishes nothing', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await expect(
      placeOrder().execute({ orderId: ORDER, version: VERSION - 1 }, member),
    ).rejects.toThrow(StaleVersionError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.Draft);
    expect(events.published).toEqual([]);
  });

  it('cannot place an order that is already paid', async () => {
    orders.put(orderIn(OrderStatus.Paid));

    await expect(
      placeOrder().execute({ orderId: ORDER, version: VERSION }, member),
    ).rejects.toThrow(OrderInvalidTransitionError);

    expect(stock.reserved).toEqual([]);
    expect(events.published).toEqual([]);
  });

  it('cannot place an order without items', async () => {
    orders.put(orderIn(OrderStatus.Draft, { lines: [] }));

    await expect(
      placeOrder().execute({ orderId: ORDER, version: VERSION }, member),
    ).rejects.toThrow(OrderHasNoItemsError);
  });

  it('reports an unknown order as not found', async () => {
    await expect(
      placeOrder().execute({ orderId: ORDER, version: VERSION }, member),
    ).rejects.toThrow(OrderNotFoundError);
  });

  it('starts no saga and asks for nothing when another writer saved the order first', async () => {
    orders.put(orderIn(OrderStatus.Draft));
    orders.writeConcurrentlyAfterNextLoad();

    await expect(
      placeOrder().execute({ orderId: ORDER, version: VERSION }, member),
    ).rejects.toThrow(ConcurrencyError);

    expect(sagas.count()).toBe(0);
    expect(stock.reserved).toEqual([]);
    expect(timeouts.scheduled).toEqual([]);
    expect(events.published).toEqual([]);
  });
});
