// The other side of the broker in a test: what the api is to this service. It sends commands
// to the `commands` exchange and reads everything the service publishes to `events` through a
// queue of its own, as any subscriber would.
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { exchanges, parseMessage } from '@oms/contracts';
import { inject } from 'vitest';

import { closeConnections } from '../setup/rabbitmq';

import { waitFor } from './waiting';

import type { AnyMessage } from '@oms/contracts';
import type { ChannelModel } from 'amqplib';

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
  /** Takes every message out of a queue nobody consumes (a dead-letter queue). */
  take(queue: string): Promise<TakenMessage[]>;
  /** Puts a message straight into a queue, as an operator moving it back would. */
  put(queue: string, content: Buffer, headers?: Record<string, unknown>): void;
  /** Closes the service's connection from the broker's side: its unacknowledged messages return. */
  killConnection(connectionName: string): Promise<void>;
  /**
   * A consumer that dies on its first message: takes one delivery of the queue and closes its
   * channel without acknowledging it. Returns the headers of that delivery, or undefined when
   * the queue gave nothing in time.
   */
  crashOn(queue: string): Promise<Record<string, unknown> | undefined>;
  close(): Promise<void>;
}

export interface TakenMessage {
  content: Buffer;
  headers: Record<string, unknown>;
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
    take: async (name) => {
      const taken: TakenMessage[] = [];
      for (;;) {
        const raw = await channel.get(name, { noAck: true });
        if (!raw) return taken;
        taken.push({ content: raw.content, headers: raw.properties.headers ?? {} });
      }
    },
    put: (name, content, headers = {}) => {
      channel.sendToQueue(name, content, { persistent: true, headers });
    },
    crashOn: async (name) => {
      const doomed = await (connection.connection as unknown as ChannelModel).createChannel();
      try {
        return await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(undefined);
          }, 1000);
          doomed
            .consume(name, (raw) => {
              clearTimeout(timer);
              resolve(raw?.properties.headers ?? {});
            })
            .catch(reject);
        });
      } finally {
        await doomed.close(); // nothing acknowledged: the broker takes the delivery back
      }
    },
    killConnection: async (connectionName) => {
      // the vhost of this test file is the path of its URL (test/setup/db.ts)
      const vhost = new URL(process.env.RABBITMQ_URL ?? '').pathname.slice(1);
      await waitFor(
        () => closeConnections(inject('rabbitManagementUrl'), vhost, connectionName),
        (closed) => closed > 0,
        { what: `a connection named ${connectionName} to close`, intervalMs: 200 },
      );
    },
    close: () => connection.close(),
  };
}
