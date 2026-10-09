import { parseMessage } from '@oms/contracts';
import { describe, expect, it } from 'vitest';

import { correlationOf } from '@infra/outbox/__test__/recording-outbox';
import { ReliableEvents } from '@infra/outbox/reliable-events';
import { Money } from '@shared/domain/money';
import type { DomainEvent } from '@shared/events/domain-event';

import { LATER, ORDER, ORDER_REF, USER, WORKSPACE } from '../domain/__test__/builders';
import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderFulfilled } from '../domain/events/order-fulfilled.event';
import { OrderPaid } from '../domain/events/order-paid.event';
import { OrderPaymentFailed } from '../domain/events/order-payment-failed.event';
import { OrderPlaced } from '../domain/events/order-placed.event';
import { OrderReturnedToDraft } from '../domain/events/order-returned-to-draft.event';

import { OrderEventsTranslator } from './order-events.translator';

import type { OrderRecipients } from '../ports/order-recipients.port';

const CORRELATION = '01990000-0000-7000-8000-c00000000001';
const EMAIL = 'buyer@example.com';
const AMOUNT = Money.of(40_50n, 'EUR');
const WIRE_AMOUNT = { amountMinor: 4050, currency: 'EUR' };
const RECIPIENT = { userId: USER, email: EMAIL };

/** Knows the address of whoever is asked for, and remembers who was. */
function recipientsKnowing(asked: string[] = []): OrderRecipients {
  return {
    of: (userId) => {
      asked.push(userId);
      return Promise.resolve({ userId, email: EMAIL });
    },
  };
}

function translate(event: DomainEvent, recipients = recipientsKnowing()) {
  const reliable = new ReliableEvents();
  new OrderEventsTranslator(correlationOf(CORRELATION), recipients, reliable);
  return reliable.translate(event);
}

const CASES = [
  {
    event: new OrderPlaced(ORDER_REF, 2, AMOUNT, LATER),
    name: 'orders.order-placed',
    payload: { orderId: ORDER, paymentAttempt: 2, amount: WIRE_AMOUNT, recipient: RECIPIENT },
  },
  {
    event: new OrderPaid(ORDER_REF, 2, 'ch_1', AMOUNT, LATER),
    name: 'orders.order-paid',
    payload: {
      orderId: ORDER,
      paymentAttempt: 2,
      chargeId: 'ch_1',
      amount: WIRE_AMOUNT,
      recipient: RECIPIENT,
    },
  },
  {
    event: new OrderCancelled(ORDER_REF, LATER),
    name: 'orders.order-cancelled',
    payload: { orderId: ORDER, recipient: RECIPIENT },
  },
  {
    event: new OrderFulfilled(ORDER_REF, LATER),
    name: 'orders.order-fulfilled',
    payload: { orderId: ORDER, recipient: RECIPIENT },
  },
  {
    event: new OrderPaymentFailed(ORDER_REF, 2, 'card_declined', AMOUNT, LATER),
    name: 'orders.order-payment-failed',
    payload: {
      orderId: ORDER,
      paymentAttempt: 2,
      reason: 'card_declined',
      amount: WIRE_AMOUNT,
      recipient: RECIPIENT,
    },
  },
  {
    event: new OrderReturnedToDraft(ORDER_REF, 2, 'out_of_stock', LATER),
    name: 'orders.order-returned-to-draft',
    payload: { orderId: ORDER, paymentAttempt: 2, reason: 'out_of_stock', recipient: RECIPIENT },
  },
];

describe('OrderEventsTranslator', () => {
  it.each(CASES)('OBX-007 $event.name becomes $name on the events exchange', async (expected) => {
    const entries = await translate(expected.event);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.exchange).toBe('events');
    expect(entries[0]?.message).toMatchObject({
      name: expected.name,
      version: 1,
      occurredAt: LATER.toISOString(),
      workspaceId: WORKSPACE,
      correlationId: CORRELATION,
      payload: expected.payload,
    });
  });

  it.each(CASES)('writes $name as its subscribers accept it', async ({ event }) => {
    const [entry] = await translate(event);

    expect(parseMessage(entry?.message)).toMatchObject({ ok: true });
  });

  it.each(CASES)('NTF-030 $name is addressed to the user who created the order', async (c) => {
    const asked: string[] = [];

    await translate(c.event, recipientsKnowing(asked));

    expect(asked).toEqual([USER]);
  });

  it('NTF-031 writes nothing for an order whose creator is not known', async () => {
    const nobody: OrderRecipients = { of: () => Promise.reject(new Error('User not found')) };

    const event = new OrderCancelled(ORDER_REF, LATER);

    await expect(translate(event, nobody)).rejects.toThrow('User not found');
  });

  it('gives every message its own id', async () => {
    const event = new OrderCancelled(ORDER_REF, LATER);
    const [first] = await translate(event);
    const [second] = await translate(event);

    expect(first?.message.messageId).not.toBe(second?.message.messageId);
  });
});
