// The publisher of the relay against a real RabbitMQ (OBX-004, OBX-005): what "published"
// means. The unit spec pins what the adapter asks of the channel; this file checks that the
// broker answers the way the adapter assumes, above all that a message with no queue comes
// back BEFORE its confirm.
import { exchanges } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OutboxConfig } from '@config/configuration';
import { connectRabbit } from '@infra/messaging/rabbit-connection';
import type { OutboxRecord } from '@infra/outbox/outbox-publisher.port';
import { RabbitOutboxPublisher } from '@infra/outbox/rabbit-outbox.publisher';
import { UnroutableMessageError } from '@infra/outbox/unroutable-message.error';
import { silentLogger } from '@shared/logger/silent-logger';

import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

const CONFIG = { publishTimeoutMs: 2000 } as OutboxConfig;
const COMMAND = 'payments.charge-payment';

let connection: AmqpConnection;
let publisher: RabbitOutboxPublisher;

beforeAll(async () => {
  connection = await connectRabbit(
    {
      url: process.env.RABBITMQ_URL ?? '',
      prefetch: 1,
      redeliveryLimit: 3,
      retry: {},
      delays: {},
    },
    silentLogger,
  );
  publisher = new RabbitOutboxPublisher(connection, CONFIG);
});
afterAll(async () => {
  await publisher.onModuleDestroy();
  await connection.close();
});

const record = (exchange: string, routingKey: string): OutboxRecord => {
  const id = uuidv7();
  return { id, exchange, routingKey, payload: { messageId: id, name: routingKey } };
};

/** A queue bound for `routingKey`, as the reader of the message would declare it. */
async function bind(exchange: string, routingKey: string): Promise<string> {
  const { queue } = await connection.channel.assertQueue('', { exclusive: true });
  await connection.channel.bindQueue(queue, exchange, routingKey);
  return queue;
}

describe('RabbitOutboxPublisher against the broker', () => {
  it('OBX-005 fails a command nobody has a queue for, and leaves no trace of it', async () => {
    const lost = record(exchanges.commands.name, COMMAND);

    await expect(publisher.publish(lost)).rejects.toThrow(UnroutableMessageError);
  });

  it('OBX-005 publishes that command once its receiver has declared the queue', async () => {
    const command = record(exchanges.commands.name, COMMAND);
    await expect(publisher.publish(command)).rejects.toThrow(UnroutableMessageError);
    const queue = await bind(exchanges.commands.name, COMMAND);

    await publisher.publish(command);

    const delivered = await connection.channel.get(queue, { noAck: true });
    expect(delivered).not.toBe(false);
    const message = delivered || undefined;
    expect(JSON.parse(message?.content.toString() ?? 'null')).toEqual(command.payload);
    expect(message?.properties).toMatchObject({ messageId: command.id, deliveryMode: 2 });
  });

  it('publishes an event with no subscriber: that is not a loss', async () => {
    const event = record(exchanges.events.name, 'orders.order-fulfilled');

    await expect(publisher.publish(event)).resolves.toBeUndefined();
  });
});
