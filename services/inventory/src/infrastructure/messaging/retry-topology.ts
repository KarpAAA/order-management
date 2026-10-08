import type { RetryPolicy } from '@config/configuration';

import type { QueueOptions } from '@golevelup/nestjs-rabbitmq';
import type { Channel, ConsumeMessage } from 'amqplib';

/**
 * The three queues of one reader (docs/adr/0013):
 *
 *   <queue> ──(rejected)──► <queue>.wait.<delayMs> ──(expired)──► <queue>
 *      └──(given up, by the error handler)──► <queue>.dlq
 *
 * The broker has no "deliver later": a queue nobody reads, whose messages expire and are
 * dead-lettered back, is the delay. The way back names the queue, not the exchange the
 * message came through, so no other subscriber gets it again.
 */

/** The delay is part of the name: another delay is another queue, not a changed argument. */
export const waitQueue = (queue: string, delayMs: number): string =>
  `${queue}.wait.${String(delayMs)}`;

export const deadLetterQueue = (queue: string): string => `${queue}.dlq`;

/**
 * How many times a consumer rejected this message from `queue`: the broker writes every
 * dead-lettering of a message into its `x-death` header.
 */
export function rejections(message: ConsumeMessage | undefined, queue: string): number {
  const deaths: unknown = message?.properties.headers?.['x-death'];
  if (!Array.isArray(deaths)) return 0;
  const entry = (deaths as { queue?: unknown; reason?: unknown; count?: unknown }[]).find(
    (death) => death.queue === queue && death.reason === 'rejected',
  );
  return Number(entry?.count ?? 0);
}

/**
 * How many times the broker took this message back unacknowledged: its consumer died, or the
 * connection did. A quorum queue counts it in `x-delivery-count`; a rejection is not counted
 * there.
 */
export function redeliveries(message: ConsumeMessage | undefined): number {
  return Number(message?.properties.headers?.['x-delivery-count'] ?? 0);
}

// Replicated when the broker is a cluster, and the only type that counts deliveries.
const QUORUM = { 'x-queue-type': 'quorum' };

/** Through the default exchange, which routes to the queue named by the routing key. */
const deadLetterTo = (queue: string) => ({
  'x-dead-letter-exchange': '',
  'x-dead-letter-routing-key': queue,
  // the message leaves this queue once the target has it; the strategy needs reject-publish
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish',
});

/** The queue the consumer reads: what it rejects goes to the wait queue. */
export const workQueueOptions = (queue: string, policy: RetryPolicy): QueueOptions => ({
  durable: true,
  arguments: { ...QUORUM, ...deadLetterTo(waitQueue(queue, policy.delayMs)) },
});

/** The wait queue and the dead-letter queue of `queue`. Nothing consumes either. */
export async function declareRetryQueues(
  channel: Channel,
  queue: string,
  policy: RetryPolicy,
): Promise<void> {
  await channel.assertQueue(waitQueue(queue, policy.delayMs), {
    durable: true,
    arguments: { ...QUORUM, 'x-message-ttl': policy.delayMs, ...deadLetterTo(queue) },
  });
  await channel.assertQueue(deadLetterQueue(queue), { durable: true, arguments: QUORUM });
}
