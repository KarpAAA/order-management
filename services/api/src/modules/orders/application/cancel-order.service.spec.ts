import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceRole } from '@shared/auth/workspace-role';
import { StaleVersionError } from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { LATER, ORDER, orderIn } from '../domain/__test__/builders';
import { OrderInvalidTransitionError } from '../domain/errors';
import { OrderStatus } from '../domain/order-status';

import { enableNoOpTransactions, fixedClock, member, tenantAs } from './__test__/fixtures';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import { CancelOrderService } from './cancel-order.service';
import { OrdersPolicy } from './orders.policy';

// The builders restore orders at version 3.
const VERSION = 3;

describe('CancelOrderService', () => {
  let orders: InMemoryOrdersRepository;
  let events: RecordingEventPublisher;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new InMemoryOrdersRepository();
    events = new RecordingEventPublisher();
  });

  const cancelOrder = (role: WorkspaceRole = WorkspaceRole.Member): CancelOrderService =>
    new CancelOrderService(orders, new OrdersPolicy(), tenantAs(role), fixedClock, events);

  it.each([OrderStatus.Draft, OrderStatus.PaymentFailed])('cancels an order in %s', async (status) => {
    orders.put(orderIn(status));

    await cancelOrder().execute({ orderId: ORDER, version: VERSION }, member);

    const saved = await orders.getById(ORDER);
    expect(saved.status).toBe(OrderStatus.Cancelled);
    expect(saved.snapshot().cancelledAt).toEqual(LATER);
    expect(saved.version).toBe(VERSION + 1);
  });

  it('publishes no events when an order is cancelled', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await cancelOrder().execute({ orderId: ORDER, version: VERSION }, member);

    expect(events.published).toEqual([]);
  });

  it('cannot cancel an order that is awaiting payment', async () => {
    orders.put(orderIn(OrderStatus.PendingPayment));

    await expect(
      cancelOrder().execute({ orderId: ORDER, version: VERSION }, member),
    ).rejects.toThrow(OrderInvalidTransitionError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.PendingPayment);
  });

  it('forbids a VIEWER and leaves the order untouched', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await expect(
      cancelOrder(WorkspaceRole.Viewer).execute({ orderId: ORDER, version: VERSION }, member),
    ).rejects.toThrow(ForbiddenError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.Draft);
  });

  it('rejects a stale version', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await expect(
      cancelOrder().execute({ orderId: ORDER, version: VERSION - 1 }, member),
    ).rejects.toThrow(StaleVersionError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.Draft);
  });
});
