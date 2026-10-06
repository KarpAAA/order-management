import { parseMessage } from '@oms/contracts';
import { describe, expect, it } from 'vitest';

import { Money } from '@shared/domain/money';

import { fixedClock } from '../application/__test__/fixtures';
import { LATER, ORDER, WORKSPACE } from '../domain/__test__/builders';

import { RabbitPaymentChargeAdapter } from './rabbit-payment-charge.adapter';

import type { ScheduledCharge } from '../ports/payment-charge-scheduler.port';
import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

interface Published {
  exchange: string;
  routingKey: string;
  message: { messageId: string; correlationId: string };
  options: unknown;
}

/** What the adapter hands to the connection; the broker itself is covered by the e2e suite. */
function recordingConnection(): { connection: AmqpConnection; published: Published[] } {
  const published: Published[] = [];
  const connection = {
    publish: (
      exchange: string,
      routingKey: string,
      message: Published['message'],
      options: unknown,
    ) => {
      published.push({ exchange, routingKey, message, options });
      return Promise.resolve(true);
    },
  } as unknown as AmqpConnection;
  return { connection, published };
}

const charge = (overrides: Partial<ScheduledCharge> = {}): ScheduledCharge => ({
  workspaceId: WORKSPACE,
  orderId: ORDER,
  paymentAttempt: 2,
  amount: Money.of(40_50n, 'EUR'),
  ...overrides,
});

async function send(scheduled: ScheduledCharge = charge()): Promise<Published> {
  const { connection, published } = recordingConnection();
  await new RabbitPaymentChargeAdapter(connection, fixedClock).schedule(scheduled);
  expect(published).toHaveLength(1);
  return published[0]!;
}

describe('RabbitPaymentChargeAdapter', () => {
  it('PAY-001 sends payments.charge-payment to the commands exchange, routed by its name', async () => {
    const sent = await send();

    expect(sent.exchange).toBe('commands');
    expect(sent.routingKey).toBe('payments.charge-payment');
    expect(sent.message).toMatchObject({
      name: 'payments.charge-payment',
      version: 1,
      occurredAt: LATER.toISOString(),
      workspaceId: WORKSPACE,
      payload: { orderId: ORDER, paymentAttempt: 2 },
    });
  });

  it('PAY-003 carries the amount to charge and the idempotency key <orderId>:<attempt>', async () => {
    const sent = await send(charge({ amount: Money.of(99_90n, 'USD'), paymentAttempt: 3 }));

    expect(sent.message).toMatchObject({
      payload: {
        amount: { amountMinor: 9990, currency: 'USD' },
        idempotencyKey: `${ORDER}:3`,
      },
    });
  });

  it('sends what the consumer accepts', async () => {
    const sent = await send();

    expect(parseMessage(sent.message)).toMatchObject({ ok: true });
  });

  it('gives every command its own message id and correlation id', async () => {
    const first = await send();
    const second = await send();

    expect(first.message.messageId).not.toBe(second.message.messageId);
    expect(first.message.correlationId).not.toBe(second.message.correlationId);
    expect(first.options).toMatchObject({
      messageId: first.message.messageId,
      correlationId: first.message.correlationId,
    });
  });

  it('refuses an amount a JSON number cannot hold instead of sending a rounded one', async () => {
    const { connection, published } = recordingConnection();
    const adapter = new RabbitPaymentChargeAdapter(connection, fixedClock);

    await expect(
      adapter.schedule(charge({ amount: Money.of(2n ** 53n + 1n, 'EUR') })),
    ).rejects.toThrow();
    expect(published).toEqual([]);
  });
});
