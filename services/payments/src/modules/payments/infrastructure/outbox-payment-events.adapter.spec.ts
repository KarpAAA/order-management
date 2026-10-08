import { parseMessage } from '@oms/contracts';
import { describe, expect, it } from 'vitest';

import { recordingOutbox } from '@infra/outbox/__test__/recording-outbox';
import type { OutboxEntry } from '@infra/outbox/outbox';
import { Clock } from '@shared/domain/clock';

import { OutboxPaymentEventsPublisher } from './outbox-payment-events.adapter';

import type { PaymentOutcome } from '../ports/payment-events-publisher.port';

const NOW = new Date('2026-10-06T10:15:30.123Z');

class FixedClock extends Clock {
  now(): Date {
    return NOW;
  }
}

const outcome = (result: PaymentOutcome['result']): PaymentOutcome => ({
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  orderId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04',
  paymentAttempt: 2,
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
  result,
});

/** What the adapter writes to the outbox; the table and the relay are covered by the e2e suite. */
async function publish(result: PaymentOutcome['result']): Promise<OutboxEntry> {
  const { outbox, appended } = recordingOutbox();
  await new OutboxPaymentEventsPublisher(outbox, new FixedClock()).publish(outcome(result));
  expect(appended).toHaveLength(1);
  return appended[0]!;
}

describe('OutboxPaymentEventsPublisher', () => {
  it('writes a success as payments.payment-succeeded for the events exchange', async () => {
    const entry = await publish({ status: 'succeeded', chargeId: 'ch_1' });

    expect(entry.exchange).toBe('events');
    expect(entry.message).toMatchObject({
      name: 'payments.payment-succeeded',
      version: 1,
      occurredAt: NOW.toISOString(),
      workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
      correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
      payload: {
        orderId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04',
        paymentAttempt: 2,
        chargeId: 'ch_1',
      },
    });
  });

  it.each([
    ['a decline', { failureCode: 'insufficient_funds', chargeId: 'ch_1' }],
    ['a provider that never answered', { failureCode: 'psp_unavailable', chargeId: null }],
  ])('writes %s as payments.payment-failed', async (_, failure) => {
    const entry = await publish({ status: 'failed', ...failure });

    expect(entry.exchange).toBe('events');
    expect(entry.message).toMatchObject({
      name: 'payments.payment-failed',
      payload: { paymentAttempt: 2, declineCode: failure.failureCode, chargeId: failure.chargeId },
    });
  });

  it('writes what a consumer accepts, with a new message id each time', async () => {
    const first = await publish({ status: 'succeeded', chargeId: 'ch_1' });
    const second = await publish({ status: 'succeeded', chargeId: 'ch_1' });

    expect(parseMessage(first.message).ok).toBe(true);
    expect(first.message.messageId).not.toBe(second.message.messageId);
  });
});
