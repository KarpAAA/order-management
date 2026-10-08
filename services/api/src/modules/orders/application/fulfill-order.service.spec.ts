import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceRole } from '@shared/auth/workspace-role';
import { StaleVersionError } from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { LATER, ORDER, orderIn, WORKSPACE } from '../domain/__test__/builders';
import { OrderFulfilled } from '../domain/events/order-fulfilled.event';
import { OrderStatus } from '../domain/order-status';

import { enableNoOpTransactions, fixedClock, member, tenantAs } from './__test__/fixtures';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import { FulfillOrderService } from './fulfill-order.service';
import { OrdersPolicy } from './orders.policy';

// The builders restore orders at version 3.
const VERSION = 3;

describe('FulfillOrderService', () => {
  let orders: InMemoryOrdersRepository;
  let events: RecordingEventPublisher;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new InMemoryOrdersRepository();
    events = new RecordingEventPublisher();
  });

  const fulfillOrder = (role: WorkspaceRole = WorkspaceRole.Admin): FulfillOrderService =>
    new FulfillOrderService(orders, new OrdersPolicy(), tenantAs(role), fixedClock, events);

  it('ORD-017 fulfills a PAID order', async () => {
    orders.put(orderIn(OrderStatus.Paid));

    await fulfillOrder().execute({ orderId: ORDER, version: VERSION }, member);

    const saved = await orders.getById(ORDER);
    expect(saved.status).toBe(OrderStatus.Fulfilled);
    expect(saved.snapshot().fulfilledAt).toEqual(LATER);
    expect(saved.version).toBe(VERSION + 1);
  });

  it('OBX-007 publishes OrderFulfilled', async () => {
    orders.put(orderIn(OrderStatus.Paid));

    await fulfillOrder().execute({ orderId: ORDER, version: VERSION }, member);

    expect(events.published).toEqual([new OrderFulfilled(WORKSPACE, ORDER, LATER)]);
  });

  it('PERM-001 forbids a MEMBER and leaves the order PAID', async () => {
    orders.put(orderIn(OrderStatus.Paid));

    await expect(
      fulfillOrder(WorkspaceRole.Member).execute({ orderId: ORDER, version: VERSION }, member),
    ).rejects.toThrow(ForbiddenError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.Paid);
  });

  it('ORD-009 rejects a stale version', async () => {
    orders.put(orderIn(OrderStatus.Paid));

    await expect(
      fulfillOrder().execute({ orderId: ORDER, version: VERSION - 1 }, member),
    ).rejects.toThrow(StaleVersionError);
  });
});
