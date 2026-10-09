// The other side of the broker in a test: what the api is to this service. It publishes
// events to the `events` exchange, as the relay of the api would. The service publishes
// nothing, so there is nothing to read back: its outcome is a row and a mail.
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { exchanges } from '@oms/contracts';

export interface TestBroker {
  /** Publishes to `events` with the message's name as the routing key. */
  publish(message: { name: string }): Promise<void>;
  /** Messages in a queue that no consumer has taken yet. */
  depth(queue: string): Promise<number>;
  /** Takes every message out of a queue nobody consumes (a dead-letter queue). */
  take(queue: string): Promise<TakenMessage[]>;
  /** Puts a message straight into a queue, as an operator moving it back would. */
  put(queue: string, content: Buffer): void;
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
  const { channel } = connection;

  return {
    publish: async (message) => {
      await connection.publish(exchanges.events.name, message.name, message);
    },
    depth: async (name) => (await channel.checkQueue(name)).messageCount,
    take: async (name) => {
      const taken: TakenMessage[] = [];
      for (;;) {
        const raw = await channel.get(name, { noAck: true });
        if (!raw) return taken;
        taken.push({ content: raw.content, headers: raw.properties.headers ?? {} });
      }
    },
    put: (name, content) => {
      channel.sendToQueue(name, content, { persistent: true });
    },
    close: () => connection.close(),
  };
}
