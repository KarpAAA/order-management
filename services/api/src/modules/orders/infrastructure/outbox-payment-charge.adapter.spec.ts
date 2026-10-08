import { parseMessage } from '@oms/contracts';
import { describe, expect, it } from 'vitest';

import { correlationOf, recordingOutbox } from '@infra/outbox/__test__/recording-outbox';
import type { OutboxEntry } from '@infra/outbox/outbox';
import { Money } from '@shared/domain/money';

import { fixedClock } from '../application/__test__/fixtures';
import { LATER, ORDER, WORKSPACE } from '../domain/__test__/builders';

import { OutboxPaymentChargeAdapter } from './outbox-payment-charge.adapter';

import type { ScheduledCharge } from '../ports/payment-charge-scheduler.port';

const CORRELATION = '01990000-0000-7000-8000-c00000000001';

const charge = (overrides: Partial<ScheduledCharge> = {}): ScheduledCharge => ({
  workspaceId: WORKSPACE,
  orderId: ORDER,
  paymentAttempt: 2,
  amount: Money.of(40_50n, 'EUR'),
  ...overrides,
});

/** What the adapter writes to the outbox; the table and the relay are covered by the int suite. */
async function schedule(scheduled: ScheduledCharge = charge()): Promise<OutboxEntry> {
  const { outbox, appended } = recordingOutbox();
  await new OutboxPaymentChargeAdapter(outbox, fixedClock, correlationOf(CORRELATION)).schedule(
    scheduled,
  );
  expect(appended).toHaveLength(1);
  return appended[0]!;
}

describe('OutboxPaymentChargeAdapter', () => {
  it('PAY-001 writes payments.charge-payment for the commands exchange', async () => {
    const entry = await schedule();

    expect(entry.exchange).toBe('commands');
    expect(entry.message).toMatchObject({
      name: 'payments.charge-payment',
      version: 1,
      occurredAt: LATER.toISOString(),
      workspaceId: WORKSPACE,
      correlationId: CORRELATION,
      payload: { orderId: ORDER, paymentAttempt: 2 },
    });
  });

  it('PAY-003 carries the amount to charge and the idempotency key <orderId>:<attempt>', async () => {
    const entry = await schedule(charge({ amount: Money.of(99_90n, 'USD'), paymentAttempt: 3 }));

    expect(entry.message).toMatchObject({
      payload: {
        amount: { amountMinor: 9990, currency: 'USD' },
        idempotencyKey: `${ORDER}:3`,
      },
    });
  });

  it('writes what the consumer accepts', async () => {
    const entry = await schedule();

    expect(parseMessage(entry.message)).toMatchObject({ ok: true });
  });

  it('gives every command its own message id', async () => {
    const first = await schedule();
    const second = await schedule();

    expect(first.message.messageId).not.toBe(second.message.messageId);
  });

  it('refuses an amount a JSON number cannot hold instead of writing a rounded one', async () => {
    const { outbox, appended } = recordingOutbox();
    const adapter = new OutboxPaymentChargeAdapter(outbox, fixedClock, correlationOf(CORRELATION));

    await expect(
      adapter.schedule(charge({ amount: Money.of(2n ** 53n + 1n, 'EUR') })),
    ).rejects.toThrow();
    expect(appended).toEqual([]);
  });
});
