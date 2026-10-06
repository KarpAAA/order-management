import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@shared/errors/forbidden-error';

import { ORDER, orderIn } from '../domain/__test__/builders';
import { OrderStatus } from '../domain/order-status';

import { enableNoOpTransactions, fixedClock, member, paymentConsumer } from './__test__/fixtures';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import { FailOrderPaymentService } from './fail-order-payment.service';
import { OrdersPolicy } from './orders.policy';

// The PENDING_PAYMENT builder waits for payment attempt 1.
const cmd = { orderId: ORDER, paymentAttempt: 1, reason: 'card_declined' };

describe('FailOrderPaymentService', () => {
  let orders: InMemoryOrdersRepository;
  let failPayment: FailOrderPaymentService;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new InMemoryOrdersRepository();
    orders.put(orderIn(OrderStatus.PendingPayment));
    failPayment = new FailOrderPaymentService(
      orders,
      new OrdersPolicy(),
      fixedClock,
      new RecordingEventPublisher(),
    );
  });

  it('PAY-005 marks the awaited attempt PAYMENT_FAILED with the reason', async () => {
    await failPayment.execute(cmd, paymentConsumer);

    expect((await orders.getById(ORDER)).snapshot()).toMatchObject({
      status: OrderStatus.PaymentFailed,
      failureReason: 'card_declined',
    });
  });

  // PaymentEventsConsumer always passes its own system actor, so this
  // use case's own check is only exercised when it is called directly.
  it('PAY-013 a user calling it directly cannot fail the payment', async () => {
    await expect(failPayment.execute(cmd, member)).rejects.toThrow(ForbiddenError);

    expect((await orders.getById(ORDER)).status).toBe(OrderStatus.PendingPayment);
  });
});
