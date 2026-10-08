import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@shared/errors/forbidden-error';

import { LATER, ORDER, orderIn, WORKSPACE } from '../domain/__test__/builders';
import { OrderPaid } from '../domain/events/order-paid.event';
import { OrderStatus } from '../domain/order-status';

import { enableNoOpTransactions, fixedClock, member, paymentConsumer } from './__test__/fixtures';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import { CompleteOrderPaymentService } from './complete-order-payment.service';
import { OrdersPolicy } from './orders.policy';

// The PENDING_PAYMENT builder waits for payment attempt 1.
const cmd = { orderId: ORDER, paymentAttempt: 1, pspChargeId: 'ch_1' };

describe('CompleteOrderPaymentService', () => {
  let orders: InMemoryOrdersRepository;
  let events: RecordingEventPublisher;
  let completePayment: CompleteOrderPaymentService;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new InMemoryOrdersRepository();
    orders.put(orderIn(OrderStatus.PendingPayment));
    events = new RecordingEventPublisher();
    completePayment = new CompleteOrderPaymentService(
      orders,
      new OrdersPolicy(),
      fixedClock,
      events,
    );
  });

  it('OBX-007 publishes OrderPaid for the attempt, with the charge id', async () => {
    await completePayment.execute(cmd, paymentConsumer);

    expect(events.published).toEqual([new OrderPaid(WORKSPACE, ORDER, 1, 'ch_1', LATER)]);
  });

  it('PAY-004 marks the awaited attempt PAID with the charge id', async () => {
    await completePayment.execute(cmd, paymentConsumer);

    expect((await orders.getById(ORDER)).snapshot()).toMatchObject({
      status: OrderStatus.Paid,
      pspChargeId: 'ch_1',
      paidAt: LATER,
    });
  });

  // PaymentEventsConsumer always passes its own system actor, so this
  // use case's own check is only exercised when it is called directly.
  it('PAY-013 a user calling it directly cannot mark the order paid', async () => {
    await expect(completePayment.execute(cmd, member)).rejects.toThrow(ForbiddenError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.PendingPayment);
  });
});
