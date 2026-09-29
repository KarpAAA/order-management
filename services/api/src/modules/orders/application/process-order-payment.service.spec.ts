import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@shared/errors/forbidden-error';

import { LATER, ORDER, orderIn } from '../domain/__test__/builders';
import { PaymentAttemptNotPendingError } from '../domain/errors';
import { OrderStatus } from '../domain/order-status';

import {
  enableNoOpTransactions,
  fixedClock,
  member,
  paymentConsumer,
  TestGatewayError,
} from './__test__/fixtures';
import { InMemoryOrdersRepository } from './__test__/in-memory-orders.repository';
import { RecordingEventPublisher } from './__test__/recording-event-publisher';
import { ScriptedPaymentGateway } from './__test__/scripted-payment-gateway';
import { CompleteOrderPaymentService } from './complete-order-payment.service';
import { FailOrderPaymentService } from './fail-order-payment.service';
import { OrdersPolicy } from './orders.policy';
import { ProcessOrderPaymentService } from './process-order-payment.service';

// The PENDING_PAYMENT builder waits for payment attempt 1.
const ATTEMPT = 1;
const charge = { orderId: ORDER, paymentAttempt: ATTEMPT, isFinalAttempt: false };

describe('ProcessOrderPaymentService', () => {
  let orders: InMemoryOrdersRepository;
  let gateway: ScriptedPaymentGateway;
  let processPayment: ProcessOrderPaymentService;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    orders = new InMemoryOrdersRepository();
    gateway = new ScriptedPaymentGateway();
    const policy = new OrdersPolicy();
    const events = new RecordingEventPublisher();
    // The outcome use cases are ours, not ports: they run for real on the same doubles.
    processPayment = new ProcessOrderPaymentService(
      orders,
      gateway,
      policy,
      new CompleteOrderPaymentService(orders, policy, fixedClock, events),
      new FailOrderPaymentService(orders, policy, fixedClock, events),
    );
    orders.put(orderIn(OrderStatus.PendingPayment));
  });

  const statusOf = async (): Promise<OrderStatus> => (await orders.getById(ORDER)).status;

  it('marks the order PAID with the charge id when the charge succeeds', async () => {
    gateway.willReturn({ status: 'succeeded', chargeId: 'ch_42' });

    await processPayment.execute(charge, paymentConsumer);

    const saved = (await orders.getById(ORDER)).snapshot();
    expect(saved.status).toBe(OrderStatus.Paid);
    expect(saved.pspChargeId).toBe('ch_42');
    expect(saved.paidAt).toEqual(LATER);
  });

  it('charges the amount due under the key <orderId>:<attempt>', async () => {
    const order = await orders.getById(ORDER);

    await processPayment.execute(charge, paymentConsumer);

    expect(gateway.requests).toEqual([
      { amount: order.amountDue, reference: ORDER, idempotencyKey: `${ORDER}:${ATTEMPT}` },
    ]);
  });

  it('records a decline as a failed payment with the decline code, without retrying', async () => {
    gateway.willReturn({ status: 'declined', chargeId: 'ch_42', declineCode: 'card_declined' });

    await processPayment.execute(charge, paymentConsumer);

    const saved = (await orders.getById(ORDER)).snapshot();
    expect(saved.status).toBe(OrderStatus.PaymentFailed);
    expect(saved.failureReason).toBe('card_declined');
  });

  it('rethrows a transient failure so the queue retries, leaving the order pending', async () => {
    gateway.willThrow(new TestGatewayError(true));

    await expect(processPayment.execute(charge, paymentConsumer)).rejects.toThrow(TestGatewayError);

    expect(await statusOf()).toBe(OrderStatus.PendingPayment);
  });

  it('fails the payment as psp_unavailable when a transient failure hits the final attempt', async () => {
    gateway.willThrow(new TestGatewayError(true));

    await processPayment.execute({ ...charge, isFinalAttempt: true }, paymentConsumer);

    const saved = (await orders.getById(ORDER)).snapshot();
    expect(saved.status).toBe(OrderStatus.PaymentFailed);
    expect(saved.failureReason).toBe('psp_unavailable'); // PAY-007, literal on purpose
  });

  it('fails the payment as psp_rejected on a non-retryable gateway failure', async () => {
    gateway.willThrow(new TestGatewayError(false));

    await processPayment.execute(charge, paymentConsumer);

    const saved = (await orders.getById(ORDER)).snapshot();
    expect(saved.status).toBe(OrderStatus.PaymentFailed);
    expect(saved.failureReason).toBe('psp_rejected'); // PAY-008, literal on purpose
  });

  it('rethrows an unexpected error and leaves the order pending', async () => {
    gateway.willThrow(new TypeError('bug in the adapter'));

    await expect(processPayment.execute(charge, paymentConsumer)).rejects.toThrow(TypeError);

    expect(await statusOf()).toBe(OrderStatus.PendingPayment);
  });

  it('does not charge a stale or duplicate payment attempt', async () => {
    await expect(
      processPayment.execute({ ...charge, paymentAttempt: ATTEMPT + 1 }, paymentConsumer),
    ).rejects.toThrow(PaymentAttemptNotPendingError);

    expect(gateway.requests).toEqual([]);
  });

  it('does not charge when a user, not the orders consumer, triggers it', async () => {
    await expect(processPayment.execute(charge, member)).rejects.toThrow(ForbiddenError);

    expect(gateway.requests).toEqual([]);
    expect(await statusOf()).toBe(OrderStatus.PendingPayment);
  });
});
