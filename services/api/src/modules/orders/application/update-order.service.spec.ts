import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceRole } from '@shared/auth/workspace-role';
import { StaleVersionError } from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { LATER, ORDER, orderIn, PRODUCT_1 } from '../domain/__test__/builders';
import { DiscountType } from '../domain/discount';
import { OrderStatus } from '../domain/order-status';

import { enableNoOpTransactions, fixedClock, member, tenantAs } from './__test__/fixtures';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { readerOver } from './__test__/order-inputs.fakes';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import { OrdersPolicy } from './orders.policy';
import { UpdateOrderService } from './update-order.service';

import type { UpdateOrderCommand } from './order-commands';

// The builders restore orders at version 3.
const VERSION = 3;

const command = (overrides: Partial<UpdateOrderCommand> = {}): UpdateOrderCommand => ({
  orderId: ORDER,
  version: VERSION,
  items: [{ productId: PRODUCT_1, quantity: 5 }],
  discount: { type: DiscountType.Fixed, valueMinor: 100n },
  ...overrides,
});

describe('UpdateOrderService', () => {
  let orders: InMemoryOrdersRepository;
  let events: RecordingEventPublisher;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new InMemoryOrdersRepository();
    events = new RecordingEventPublisher();
  });

  const updateOrder = (role: WorkspaceRole = WorkspaceRole.Member): UpdateOrderService =>
    new UpdateOrderService(
      orders,
      new OrdersPolicy(),
      tenantAs(role),
      readerOver(),
      fixedClock,
      events,
    );

  it('ORD-008 replaces items and discount of a DRAFT', async () => {
    orders.put(orderIn(OrderStatus.Draft, { lines: [] }));

    await updateOrder().execute(command(), member);

    const saved = await orders.getById(ORDER);
    expect(saved.lines.map((line) => [line.productId, line.quantity])).toEqual([[PRODUCT_1, 5]]);
    expect(saved.snapshot()).toMatchObject({
      discount: { type: DiscountType.Fixed, valueMinor: 100n },
      updatedAt: LATER,
    });
    expect(saved.version).toBe(VERSION + 1);
  });

  it('forbids a VIEWER and leaves the order untouched', async () => {
    const before = orderIn(OrderStatus.Draft);
    orders.put(before);

    await expect(updateOrder(WorkspaceRole.Viewer).execute(command(), member)).rejects.toThrow(
      ForbiddenError,
    );

    expect((await orders.getById(ORDER)).snapshot()).toEqual(before.snapshot());
  });

  it('ORD-009 rejects a stale version', async () => {
    orders.put(orderIn(OrderStatus.Draft));

    await expect(updateOrder().execute(command({ version: VERSION - 1 }), member)).rejects.toThrow(
      StaleVersionError,
    );
  });

  it('ORD-008 cannot edit an order that left DRAFT', async () => {
    orders.put(orderIn(OrderStatus.Paid));

    await expect(updateOrder().execute(command(), member)).rejects.toThrow(
      expect.objectContaining({ code: 'ORDER_NOT_EDITABLE' }),
    );
  });
});
