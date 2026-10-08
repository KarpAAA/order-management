import { parseMessage } from '@oms/contracts';
import { describe, expect, it } from 'vitest';

import { correlationOf } from '@infra/outbox/__test__/recording-outbox';
import { ReliableEvents } from '@infra/outbox/reliable-events';
import { Money } from '@shared/domain/money';
import type { DomainEvent } from '@shared/events/domain-event';

import { LATER, ORDER, WORKSPACE } from '../domain/__test__/builders';
import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderFulfilled } from '../domain/events/order-fulfilled.event';
import { OrderPaid } from '../domain/events/order-paid.event';
import { OrderPlaced } from '../domain/events/order-placed.event';

import { OrderEventsTranslator } from './order-events.translator';

const CORRELATION = '01990000-0000-7000-8000-c00000000001';

function translate(event: DomainEvent) {
  const reliable = new ReliableEvents();
  new OrderEventsTranslator(correlationOf(CORRELATION), reliable);
  return reliable.translate(event);
}

const CASES = [
  {
    event: new OrderPlaced(WORKSPACE, ORDER, 2, Money.of(40_50n, 'EUR'), LATER),
    name: 'orders.order-placed',
    payload: {
      orderId: ORDER,
      paymentAttempt: 2,
      amount: { amountMinor: 4050, currency: 'EUR' },
    },
  },
  {
    event: new OrderPaid(WORKSPACE, ORDER, 2, 'ch_1', LATER),
    name: 'orders.order-paid',
    payload: { orderId: ORDER, paymentAttempt: 2, chargeId: 'ch_1' },
  },
  {
    event: new OrderCancelled(WORKSPACE, ORDER, LATER),
    name: 'orders.order-cancelled',
    payload: { orderId: ORDER },
  },
  {
    event: new OrderFulfilled(WORKSPACE, ORDER, LATER),
    name: 'orders.order-fulfilled',
    payload: { orderId: ORDER },
  },
];

describe('OrderEventsTranslator', () => {
  it.each(CASES)('OBX-007 $event.name becomes $name on the events exchange', (expected) => {
    const entries = translate(expected.event);

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

  it.each(CASES)('writes $name as its subscribers accept it', ({ event }) => {
    const [entry] = translate(event);

    expect(parseMessage(entry?.message)).toMatchObject({ ok: true });
  });

  it('gives every message its own id', () => {
    const event = new OrderCancelled(WORKSPACE, ORDER, LATER);

    expect(translate(event)[0]?.message.messageId).not.toBe(translate(event)[0]?.message.messageId);
  });
});
