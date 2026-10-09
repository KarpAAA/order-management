import { DELAYED_EXCHANGE } from '@shared/messaging/delayed';

import { deadLetterTo, QUORUM } from './retry-topology';

import type { Channel } from 'amqplib';

/**
 * A message that arrives later (docs/adr/0017-order-saga.md):
 *
 *   api.delayed ──(routing key = the delay queue)──► <queue>.delay.<delayMs> ──(expired)──► <queue>
 *
 * The same means as a retry (retry-topology.ts): the broker has no "deliver later", so the
 * message waits in a queue nobody reads, expires there and is dead-lettered to its reader.
 * A queue has one delay: every message in it expires in the order it came, and none waits
 * behind a longer one.
 *
 * The wait starts when the broker takes the message, not when it was written: published
 * late (the relay of the outbox was away), it arrives late, never early.
 */

/** The delay is part of the name: another delay is another queue, not a changed argument. */
export const delayQueue = (queue: string, delayMs: number): string =>
  `${queue}.delay.${String(delayMs)}`;

/** The exchange and one queue per delay of `queue`. Nothing consumes the delay queues. */
export async function declareDelayQueues(
  channel: Channel,
  queue: string,
  delaysMs: readonly number[],
): Promise<void> {
  await channel.assertExchange(DELAYED_EXCHANGE, 'direct', { durable: true });
  for (const delayMs of new Set(delaysMs)) {
    const name = delayQueue(queue, delayMs);
    await channel.assertQueue(name, {
      durable: true,
      arguments: { ...QUORUM, 'x-message-ttl': delayMs, ...deadLetterTo(queue) },
    });
    await channel.bindQueue(name, DELAYED_EXCHANGE, name);
  }
}
