import { parseMessage } from '@oms/contracts';
import { describe, expect, it } from 'vitest';

import { Clock } from '@shared/domain/clock';

import { RabbitPaymentEventsPublisher } from './rabbit-payment-events.adapter';

import type { PaymentOutcome } from '../ports/payment-events-publisher.port';
import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

const NOW = new Date('2026-10-06T10:15:30.123Z');

class FixedClock extends Clock {
  now(): Date {
    return NOW;
  }
}

interface Published {
  exchange: string;
  routingKey: string;
  message: unknown;
  options: unknown;
}

/** What the adapter hands to the connection; the broker itself is covered by the e2e suite. */
function recordingConnection(): { connection: AmqpConnection; published: Published[] } {
  const published: Published[] = [];
  const connection = {
    publish: (exchange: string, routingKey: string, message: unknown, options: unknown) => {
      published.push({ exchange, routingKey, message, options });
      return Promise.resolve(true);
    },
  } as unknown as AmqpConnection;
  return { connection, published };
}

const outcome = (result: PaymentOutcome['result']): PaymentOutcome => ({
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  orderId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04',
  paymentAttempt: 2,
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
  result,
});

async function publish(result: PaymentOutcome['result']): Promise<Published> {
  const { connection, published } = recordingConnection();
  await new RabbitPaymentEventsPublisher(connection, new FixedClock()).publish(outcome(result));
  expect(published).toHaveLength(1);
  return published[0]!;
}

describe('RabbitPaymentEventsPublisher', () => {
  it('publishes a success as payments.payment-succeeded, routed by its name', async () => {
    const sent = await publish({ status: 'succeeded', chargeId: 'ch_1' });

    expect(sent.exchange).toBe('events');
    expect(sent.routingKey).toBe('payments.payment-succeeded');
    expect(sent.message).toMatchObject({
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
  ])('publishes %s as payments.payment-failed', async (_, failure) => {
    const sent = await publish({ status: 'failed', ...failure });

    expect(sent.routingKey).toBe('payments.payment-failed');
    expect(sent.message).toMatchObject({
      name: 'payments.payment-failed',
      payload: { paymentAttempt: 2, declineCode: failure.failureCode, chargeId: failure.chargeId },
    });
  });

  it('sends what a consumer accepts, with a new message id each time', async () => {
    const first = await publish({ status: 'succeeded', chargeId: 'ch_1' });
    const second = await publish({ status: 'succeeded', chargeId: 'ch_1' });

    const parsed = parseMessage(first.message);
    expect(parsed.ok).toBe(true);
    const ids = [first, second].map((sent) => (sent.message as { messageId: string }).messageId);
    expect(new Set(ids).size).toBe(2);
    expect(first.options).toMatchObject({ messageId: ids[0] });
  });
});
