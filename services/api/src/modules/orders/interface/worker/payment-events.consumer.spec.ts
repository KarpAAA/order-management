import { Logger } from '@nestjs/common';
import { ChargePaymentV1, PaymentFailedV1, PaymentSucceededV1 } from '@oms/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CorrelationContext } from '@common/messaging/correlation-context';
import type { TenantContext } from '@common/tenancy/tenant-context';
import { ConcurrencyError, InvalidStateError, NotFoundError } from '@shared/errors/domain-error';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import type { Inbox } from '@shared/messaging/inbox';

import { PaymentEventsConsumer } from './payment-events.consumer';

import type { CompleteOrderPaymentService } from '../../application/complete-order-payment.service';
import type { FailOrderPaymentService } from '../../application/fail-order-payment.service';
import type { MessageMeta } from '@oms/contracts';

const WORKSPACE = '01990000-0000-7000-8000-a00000000000';
const ORDER = '01990000-0000-7000-8000-a20000000001';

const META: MessageMeta = {
  messageId: '01990000-0000-7000-8000-a30000000001',
  occurredAt: new Date('2026-10-06T10:15:30.123Z'),
  workspaceId: WORKSPACE,
  correlationId: '01990000-0000-7000-8000-a30000000002',
};
const ATTEMPT = { orderId: ORDER, paymentAttempt: 2 };

const succeeded = PaymentSucceededV1.create(META, { ...ATTEMPT, chargeId: 'ch_1' });
const failed = PaymentFailedV1.create(META, {
  ...ATTEMPT,
  declineCode: 'insufficient_funds',
  chargeId: null,
});

class NotPayable extends InvalidStateError {
  readonly code = 'NOT_PAYABLE';
}

class OrderNotFound extends NotFoundError {
  readonly code = 'ORDER_NOT_FOUND';
}

/** The inbox without a database: a message is recorded when its handler returns, as on commit. */
class MemoryInbox implements Inbox {
  readonly handled: string[] = [];

  async once(consumer: string, messageId: string, handle: () => Promise<void>): Promise<boolean> {
    const key = `${consumer}/${messageId}`;
    if (this.handled.includes(key)) return false;
    await handle();
    this.handled.push(key);
    return true;
  }
}

/** The consumer with its use cases replaced by spies; the tenant runs the work directly. */
function consumerWith({
  complete = vi.fn().mockResolvedValue(undefined),
  fail = vi.fn().mockResolvedValue(undefined),
}: {
  complete?: CompleteOrderPaymentService['execute'];
  fail?: FailOrderPaymentService['execute'];
} = {}) {
  const runInWorkspace = vi.fn((_workspaceId: string, work: () => Promise<unknown>) => work());
  const continued: string[] = [];
  const inbox = new MemoryInbox();
  const consumer = new PaymentEventsConsumer(
    { runInWorkspace } as unknown as TenantContext,
    { continue: (id: string) => continued.push(id) } as unknown as CorrelationContext,
    inbox,
    { execute: complete } as CompleteOrderPaymentService,
    { execute: fail } as FailOrderPaymentService,
  );
  return { consumer, runInWorkspace, continued, inbox, complete, fail };
}

describe('PaymentEventsConsumer', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PAY-004 completes the payment of a succeeded attempt, as the consumer system actor', async () => {
    const { consumer, complete, fail } = consumerWith();

    await expect(consumer.onPaymentEvent(succeeded)).resolves.toBeUndefined();

    expect(complete).toHaveBeenCalledWith(
      { orderId: ORDER, paymentAttempt: 2, pspChargeId: 'ch_1' },
      expect.objectContaining({ kind: 'system', source: 'consumer:orders' }),
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it('PAY-005 fails the payment of a failed attempt with its decline code', async () => {
    const { consumer, complete, fail } = consumerWith();

    await expect(consumer.onPaymentEvent(failed)).resolves.toBeUndefined();

    expect(fail).toHaveBeenCalledWith(
      { orderId: ORDER, paymentAttempt: 2, reason: 'insufficient_funds' },
      expect.objectContaining({ kind: 'system', source: 'consumer:orders' }),
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('PAY-012 binds the tenant from the envelope of the message', async () => {
    const { consumer, runInWorkspace } = consumerWith();

    await consumer.onPaymentEvent(succeeded);

    expect(runInWorkspace).toHaveBeenCalledWith(WORKSPACE, expect.any(Function));
  });

  it('OBX-008 continues the correlation of the message: what the order publishes carries it', async () => {
    const { consumer, continued } = consumerWith();

    await consumer.onPaymentEvent(succeeded);

    expect(continued).toEqual([META.correlationId]);
  });

  it('IBX-001 handles a message once: the same one delivered again calls no use case', async () => {
    const { consumer, inbox, complete } = consumerWith();

    await consumer.onPaymentEvent(succeeded);
    await expect(consumer.onPaymentEvent(succeeded)).resolves.toBeUndefined();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(inbox.handled).toEqual([`api.payment-events/${META.messageId}`]);
  });

  it('IBX-001 tells messages apart by their id, not by what they say', async () => {
    const { consumer, complete } = consumerWith();
    const again = PaymentSucceededV1.create(
      { ...META, messageId: '01990000-0000-7000-8000-a30000000009' },
      { ...ATTEMPT, chargeId: 'ch_1' },
    );

    await consumer.onPaymentEvent(succeeded);
    await consumer.onPaymentEvent(again);

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('IBX-002 a message whose handling failed is not recorded: the next delivery handles it', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('database is down'))
      .mockResolvedValue(undefined);
    const { consumer, inbox } = consumerWith({ complete });

    await expect(consumer.onPaymentEvent(succeeded)).rejects.toThrow('database is down');
    expect(inbox.handled).toEqual([]);
    await consumer.onPaymentEvent(succeeded);

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('PAY-009 acknowledges an event whose attempt is already settled (delivered twice or late)', async () => {
    const { consumer } = consumerWith({
      complete: vi.fn().mockRejectedValue(new NotPayable('settled')),
    });

    await expect(consumer.onPaymentEvent(succeeded)).resolves.toBeUndefined();
  });

  it.each([
    ['a failure of the outside world', new Error('database is down')],
    ['a concurrent write of the same order', new ConcurrencyError('Order', ORDER)],
  ])('PAY-016 lets %s out as it is: the message is delivered again', async (_, error) => {
    const { consumer } = consumerWith({ complete: vi.fn().mockRejectedValue(error) });

    await expect(consumer.onPaymentEvent(succeeded)).rejects.toBe(error);
  });

  it('PAY-015 gives up an event business refuses for good: another delivery finds no order either', async () => {
    const refusal = new OrderNotFound('no such order');
    const { consumer } = consumerWith({ complete: vi.fn().mockRejectedValue(refusal) });

    const thrown = await consumer.onPaymentEvent(succeeded).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(UnprocessableMessageError);
    expect(thrown).toMatchObject({ message: 'ORDER_NOT_FOUND: no such order', cause: refusal });
  });

  it.each([
    ['not a message', { hello: 'world' }],
    ['a version this build does not know', { ...succeeded, version: 2 }],
    ['an event that breaks its contract', { ...succeeded, payload: { orderId: 'nope' } }],
    [
      'a message of another queue',
      ChargePaymentV1.create(META, {
        ...ATTEMPT,
        amount: { amountMinor: 100, currency: 'EUR' },
        idempotencyKey: `${ORDER}:2`,
      }),
    ],
    // what the connection hands over when the bytes are not JSON
    ['bytes that are not JSON', 'not json'],
  ])('PAY-015 gives up %s at once, and calls no use case', async (_, raw) => {
    const { consumer, complete, fail } = consumerWith();

    await expect(consumer.onPaymentEvent(raw)).rejects.toBeInstanceOf(UnprocessableMessageError);

    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});
