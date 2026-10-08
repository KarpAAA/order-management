// A message that arrives later (OBX-011, OBX-012), against a real Postgres and a real
// RabbitMQ: the row `Outbox.appendDelayed()` writes, and what the broker does with it once
// the publisher of the relay has handed it over. The relay itself is in
// outbox-relay.int-spec.ts; who sends such messages and why is the saga (test/orders).
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OutboxConfig } from '@config/configuration';
import { declareDelayQueues, delayQueue } from '@infra/messaging/delay-topology';
import { connectRabbit } from '@infra/messaging/rabbit-connection';
import { Outbox } from '@infra/outbox/outbox';
import { RabbitOutboxPublisher } from '@infra/outbox/rabbit-outbox.publisher';
import { UnroutableMessageError } from '@infra/outbox/unroutable-message.error';

import { createIntModule, type IntModule } from '../helpers/int-module';
import { waitFor } from '../helpers/waiting';
import { WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

const CONFIG = { publishTimeoutMs: 2000 } as OutboxConfig;
/** The queue that reads the messages when their wait is over. */
const READER = 'test.timeouts';
const SHORT_MS = 300;
const LONG_MS = 1500;

let app: IntModule;
let outbox: Outbox;
let connection: AmqpConnection;
let publisher: RabbitOutboxPublisher;

beforeAll(async () => {
  app = await createIntModule({ providers: [Outbox] });
  outbox = app.get(Outbox);
  connection = await connectRabbit({
    url: process.env.RABBITMQ_URL ?? '',
    prefetch: 1,
    redeliveryLimit: 3,
    retry: {},
    delays: {},
  });
  // what RabbitSubscribers declares beside a consumer whose queue has delays in the config
  await connection.channel.assertQueue(READER, { durable: true });
  await declareDelayQueues(connection.channel, READER, [SHORT_MS, LONG_MS]);
  publisher = new RabbitOutboxPublisher(connection, CONFIG);
});
afterAll(async () => {
  await publisher.onModuleDestroy();
  await connection.close();
  await app.close();
});

const message = (name = 'test.timeout') => ({
  messageId: uuidv7(),
  name,
  occurredAt: new Date().toISOString(),
});

/** Writes the delayed message as a use case would, and returns its row as the relay reads it. */
async function written(delayMs: number, envelope = message()) {
  await app.inWorkspaceTx(WS_ACME, () =>
    outbox.appendDelayed({ queue: READER, delayMs, message: envelope }),
  );
  const row = await testDb().outboxMessage.findUniqueOrThrow({
    where: { id: envelope.messageId },
  });
  return { id: row.id, exchange: row.exchange, routingKey: row.routingKey, payload: row.payload };
}

const arrived = async (): Promise<string[]> => {
  const ids: string[] = [];
  for (;;) {
    const raw = await connection.channel.get(READER, { noAck: true });
    if (!raw) return ids;
    ids.push(String(raw.properties.messageId));
  }
};

describe('a delayed message is a row of the outbox (OBX-011)', () => {
  it('is addressed to the delay queue of its reader, through the exchange of the service', async () => {
    const envelope = message();

    const row = await written(SHORT_MS, envelope);

    expect(row).toEqual({
      id: envelope.messageId,
      exchange: 'api.delayed',
      routingKey: 'test.timeouts.delay.300',
      payload: envelope,
    });
    expect(delayQueue(READER, SHORT_MS)).toBe(row.routingKey);
  });

  it('cannot be written outside a transaction: the wait would begin without it', async () => {
    await expect(
      outbox.appendDelayed({ queue: READER, delayMs: SHORT_MS, message: message() }),
    ).rejects.toThrow('must be called inside @Transactional()');
  });
});

describe('a delayed message reaches its reader when the wait is over (OBX-012)', () => {
  it('is not there before its delay, and is there after it', async () => {
    const row = await written(SHORT_MS);
    const publishedAt = Date.now();

    await publisher.publish(row);

    expect(await arrived()).toEqual([]);
    const ids = await waitFor(arrived, (list) => list.length > 0, {
      what: 'the delayed message at its reader',
    });
    expect(ids).toEqual([row.id]);
    // the broker counts in milliseconds; the margin is for the clock of the test
    expect(Date.now() - publishedAt).toBeGreaterThanOrEqual(SHORT_MS - 50);
  });

  it('does not wait behind a message with a longer delay: a delay is a queue of its own', async () => {
    const slow = await written(LONG_MS);
    const fast = await written(SHORT_MS);

    await publisher.publish(slow);
    await publisher.publish(fast);

    const first = await waitFor(arrived, (list) => list.length > 0, {
      what: 'the message with the shorter delay',
    });
    expect(first).toEqual([fast.id]);
    const second = await waitFor(arrived, (list) => list.length > 0, {
      what: 'the message with the longer delay',
    });
    expect(second).toEqual([slow.id]);
  });

  it('is refused for a delay no queue was declared for, and stays in the outbox', async () => {
    const row = await written(SHORT_MS + 1);

    await expect(publisher.publish(row)).rejects.toThrow(UnroutableMessageError);
  });
});
