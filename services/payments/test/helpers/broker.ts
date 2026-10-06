// The other side of the broker in a test: what the api is to this service. It sends commands
// to the `commands` exchange and reads everything the service publishes to `events` through a
// queue of its own, as any subscriber would.
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { exchanges, parseMessage } from '@oms/contracts';

import { waitFor } from './waiting';

import type { AnyMessage } from '@oms/contracts';

export interface TestBroker {
  /** Publishes to `commands` with the message's name as the routing key. */
  send(message: { name: string }): Promise<void>;
  /** Publishes bytes as they are: for what no producer of ours would send. */
  sendRaw(routingKey: string, content: Buffer): void;
  /** Events published for the order so far, in arrival order. */
  events(orderId: string): AnyMessage[];
  /** Until `count` events for the order have arrived. */
  waitForEvents(orderId: string, count?: number): Promise<AnyMessage[]>;
  /** Messages in a queue that no consumer has taken yet. */
  depth(queue: string): Promise<number>;
  close(): Promise<void>;
}

const silent = { log: () => undefined, error: () => undefined, warn: () => undefined };

export async function connectTestBroker(): Promise<TestBroker> {
  const connection = new AmqpConnection({
    uri: process.env.RABBITMQ_URL ?? '',
    exchanges: Object.values(exchanges).map(({ name, type }) => ({ name, type })),
    enableDirectReplyTo: false,
    logger: silent,
  });
  await connection.init();

  const received: AnyMessage[] = [];
  const { channel } = connection;
  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, exchanges.events.name, '#');
  await channel.consume(
    queue,
    (raw) => {
      if (!raw) return;
      const parsed = parseMessage(JSON.parse(raw.content.toString()));
      if (parsed.ok) received.push(parsed.message);
    },
    { noAck: true },
  );

  const events = (orderId: string): AnyMessage[] =>
    received.filter((message) => message.payload.orderId === orderId);

  return {
    send: async (message) => {
      await connection.publish(exchanges.commands.name, message.name, message);
    },
    sendRaw: (routingKey, content) => {
      channel.publish(exchanges.commands.name, routingKey, content);
    },
    events,
    waitForEvents: (orderId, count = 1) =>
      waitFor(
        () => events(orderId),
        (list) => list.length >= count,
        { what: `${String(count)} event(s) for order ${orderId}` },
      ),
    depth: async (name) => (await channel.checkQueue(name)).messageCount,
    close: () => connection.close(),
  };
}
