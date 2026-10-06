import { Nack } from '@golevelup/nestjs-rabbitmq';
import { Logger } from '@nestjs/common';
import { ChargePaymentV1, PaymentFailedV1, PaymentSucceededV1 } from '@oms/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '@common/tenancy/tenant-context';
import { InvalidStateError } from '@shared/errors/domain-error';

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

/** The consumer with its use cases replaced by spies; the tenant runs the work directly. */
function consumerWith({
  complete = vi.fn().mockResolvedValue(undefined),
  fail = vi.fn().mockResolvedValue(undefined),
}: {
  complete?: CompleteOrderPaymentService['execute'];
  fail?: FailOrderPaymentService['execute'];
} = {}) {
  const runInWorkspace = vi.fn((_workspaceId: string, work: () => Promise<unknown>) => work());
  const consumer = new PaymentEventsConsumer(
    { runInWorkspace } as unknown as TenantContext,
    { execute: complete } as CompleteOrderPaymentService,
    { execute: fail } as FailOrderPaymentService,
  );
  return { consumer, runInWorkspace, complete, fail };
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

  it('PAY-009 acknowledges an event whose attempt is already settled (delivered twice or late)', async () => {
    const { consumer } = consumerWith({
      complete: vi.fn().mockRejectedValue(new NotPayable('settled')),
    });

    await expect(consumer.onPaymentEvent(succeeded)).resolves.toBeUndefined();
  });

  it('lets any other failure reject the message: the connection decides what happens to it', async () => {
    const error = new Error('database is down');
    const { consumer } = consumerWith({ complete: vi.fn().mockRejectedValue(error) });

    await expect(consumer.onPaymentEvent(succeeded)).rejects.toBe(error);
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
  ])('rejects %s without putting it back, and calls no use case', async (_, raw) => {
    const { consumer, complete, fail } = consumerWith();

    const answer = await consumer.onPaymentEvent(raw);

    expect(answer).toBeInstanceOf(Nack);
    expect(answer?.requeue).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});
