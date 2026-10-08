import { parseMessage } from '@oms/contracts';
import { describe, expect, it } from 'vitest';

import { recordingOutbox } from '@infra/outbox/__test__/recording-outbox';
import type { OutboxEntry } from '@infra/outbox/outbox';
import { Clock } from '@shared/domain/clock';

import {
  ATTEMPT,
  NOW,
  ORDER_ID,
  PRODUCT_A,
  PRODUCT_B,
  stockItem,
} from '../domain/__test__/builders';
import { Reservation } from '../domain/reservation';

import { OutboxInventoryEventsPublisher } from './outbox-inventory-events.adapter';

import type { InventoryEventsPublisher } from '../ports/inventory-events-publisher.port';

const SENT_AT = new Date('2026-10-09T10:15:30.123Z');
const CORRELATION_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03';

class FixedClock extends Clock {
  now(): Date {
    return SENT_AT;
  }
}

/** What the adapter writes to the outbox; the table and the relay are covered by the e2e suite. */
async function written(
  answer: (publisher: InventoryEventsPublisher) => Promise<void>,
): Promise<OutboxEntry> {
  const { outbox, appended } = recordingOutbox();
  await answer(new OutboxInventoryEventsPublisher(outbox, new FixedClock()));
  expect(appended).toHaveLength(1);
  return appended[0]!;
}

const held = Reservation.hold({
  ...ATTEMPT,
  now: NOW,
  lines: [{ productId: PRODUCT_A, quantity: 2 }],
});
const rejected = Reservation.reject({
  ...ATTEMPT,
  now: NOW,
  lines: [
    { productId: PRODUCT_A, quantity: 2, available: null },
    { productId: PRODUCT_B, quantity: 5, available: 1 },
  ],
});
const releasedAhead = Reservation.releaseAhead({ ...ATTEMPT, now: NOW });

const ENVELOPE = {
  version: 1,
  occurredAt: SENT_AT.toISOString(),
  workspaceId: ATTEMPT.workspaceId,
  correlationId: CORRELATION_ID,
};
const ATTEMPT_PAYLOAD = { orderId: ORDER_ID, attempt: 1 };

describe('OutboxInventoryEventsPublisher', () => {
  it.each([
    {
      name: 'a held reservation as inventory.stock-reserved',
      answer: (p: InventoryEventsPublisher) => p.reservationAnswered(held, CORRELATION_ID),
      message: { name: 'inventory.stock-reserved', payload: ATTEMPT_PAYLOAD },
    },
    {
      name: 'a rejected reservation as inventory.stock-reservation-failed, with what fell short',
      answer: (p: InventoryEventsPublisher) => p.reservationAnswered(rejected, CORRELATION_ID),
      message: {
        name: 'inventory.stock-reservation-failed',
        payload: {
          ...ATTEMPT_PAYLOAD,
          reason: 'insufficient_stock',
          shortages: [{ productId: PRODUCT_B, requested: 5, available: 1 }],
        },
      },
    },
    {
      name: 'a reservation released ahead of its reserve as inventory.stock-released',
      answer: (p: InventoryEventsPublisher) => p.reservationAnswered(releasedAhead, CORRELATION_ID),
      message: { name: 'inventory.stock-released', payload: ATTEMPT_PAYLOAD },
    },
    {
      name: 'a release as inventory.stock-released',
      answer: (p: InventoryEventsPublisher) => p.stockReleased(ATTEMPT, CORRELATION_ID),
      message: { name: 'inventory.stock-released', payload: ATTEMPT_PAYLOAD },
    },
    {
      name: 'an adjustment as inventory.stock-adjusted, with the levels after it',
      answer: (p: InventoryEventsPublisher) =>
        p.stockAdjusted(stockItem({ onHand: 60, reserved: 4 }), CORRELATION_ID),
      message: {
        name: 'inventory.stock-adjusted',
        payload: { productId: PRODUCT_A, onHand: 60, reserved: 4 },
      },
    },
  ])('writes $name, for the events exchange', async ({ answer, message }) => {
    const entry = await written(answer);

    expect(entry.exchange).toBe('events');
    expect(entry.message).toMatchObject({ ...ENVELOPE, ...message });
    // what a consumer reads is what was written
    expect(parseMessage(JSON.parse(JSON.stringify(entry.message)))).toEqual({
      ok: true,
      message: entry.message,
    });
  });

  it('gives every message an id of its own: an answer given twice is two messages', async () => {
    const first = await written((p) => p.stockReleased(ATTEMPT, CORRELATION_ID));
    const second = await written((p) => p.stockReleased(ATTEMPT, CORRELATION_ID));

    expect(first.message.messageId).not.toBe(second.message.messageId);
  });
});
