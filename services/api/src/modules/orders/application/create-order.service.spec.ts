import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceRole } from '@shared/auth/workspace-role';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { LATER, PRODUCT_1, PRODUCT_2, USER, WORKSPACE } from '../domain/__test__/builders';
import { DiscountType, NO_DISCOUNT } from '../domain/discount';
import { OrderStatus } from '../domain/order-status';

import { enableNoOpTransactions, fixedClock, member, tenantAs } from './__test__/fixtures';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { fakeIdentity, readerOver } from './__test__/order-inputs.fakes';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import { CreateOrderService } from './create-order.service';
import { OrdersPolicy } from './orders.policy';

import type { CreateOrderCommand } from './order-commands';

const command = (overrides: Partial<CreateOrderCommand> = {}): CreateOrderCommand => ({
  workspaceId: WORKSPACE,
  items: [{ productId: PRODUCT_1, quantity: 2 }],
  ...overrides,
});

describe('CreateOrderService', () => {
  let orders: InMemoryOrdersRepository;
  let events: RecordingEventPublisher;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new InMemoryOrdersRepository();
    events = new RecordingEventPublisher();
  });

  const createOrder = (role: WorkspaceRole = WorkspaceRole.Member): CreateOrderService =>
    new CreateOrderService(
      orders,
      new OrdersPolicy(),
      tenantAs(role),
      readerOver(undefined, fakeIdentity({ currency: 'USD', taxRateBps: 700 })),
      fixedClock,
      events,
    );

  it('ORD-001 stores a DRAFT with the requested items, created by the caller', async () => {
    const { id } = await createOrder().execute(command(), member);

    const saved = (await orders.getById(id)).snapshot();
    expect(saved).toMatchObject({
      workspaceId: WORKSPACE,
      status: OrderStatus.Draft,
      createdBy: USER,
      createdAt: LATER,
      discount: NO_DISCOUNT,
    });
    expect(saved.lines.map((line) => [line.productId, line.quantity])).toEqual([[PRODUCT_1, 2]]);
    expect(events.published).toEqual([]);
  });

  it('CALC-012 CALC-013 snapshots the currency and tax rate of the workspace', async () => {
    const { id } = await createOrder().execute(command(), member);

    expect((await orders.getById(id)).snapshot()).toMatchObject({
      currency: 'USD',
      taxRateBps: 700,
    });
  });

  it('ORD-007 applies the requested discount', async () => {
    const { id } = await createOrder().execute(
      command({ discount: { type: DiscountType.Percent, valueBps: 1000 } }),
      member,
    );

    expect((await orders.getById(id)).snapshot().discount).toEqual({
      type: DiscountType.Percent,
      valueBps: 1000,
    });
  });

  it('forbids a VIEWER and stores nothing', async () => {
    await expect(createOrder(WorkspaceRole.Viewer).execute(command(), member)).rejects.toThrow(
      ForbiddenError,
    );

    expect(orders.count()).toBe(0);
  });

  it('ORD-006 refuses an archived product and stores nothing', async () => {
    await expect(
      createOrder().execute(command({ items: [{ productId: PRODUCT_2, quantity: 1 }] }), member),
    ).rejects.toThrow(expect.objectContaining({ code: 'PRODUCT_NOT_ACTIVE' }));

    expect(orders.count()).toBe(0);
  });
});
