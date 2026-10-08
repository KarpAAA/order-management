import { describe, expect, it } from 'vitest';

import type { OutboxConfig } from '@config/configuration';

import { RabbitOutboxPublisher } from './rabbit-outbox.publisher';
import { UnroutableMessageError } from './unroutable-message.error';

import type { OutboxRecord } from './outbox-publisher.port';
import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

const CONFIG = { publishTimeoutMs: 1234 } as OutboxConfig;

interface Sent {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Record<string, unknown>;
}

type ReturnListener = (message: { properties: { messageId?: unknown } }) => void;

/**
 * The channel as the publisher sees it: what it was created with, what was published on it,
 * and a broker that hands back every message whose routing key is in `unroutable`, before it
 * confirms, as RabbitMQ does.
 */
function brokerWith({ unroutable = [] as string[], confirms = true } = {}) {
  const sent: Sent[] = [];
  let created: Record<string, unknown> = {};
  let onReturn: ReturnListener = () => undefined;
  let closed = false;

  const channel = {
    publish: (
      exchange: string,
      routingKey: string,
      content: Buffer,
      options: Record<string, unknown>,
    ) => {
      sent.push({ exchange, routingKey, content, options });
      if (!confirms) return Promise.reject(new Error('timeout'));
      if (options.mandatory === true && unroutable.includes(routingKey)) {
        onReturn({ properties: { messageId: options.messageId } });
      }
      return Promise.resolve(true);
    },
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
  const amqp = {
    managedConnection: {
      createChannel: (options: Record<string, unknown> & { setup: (raw: unknown) => void }) => {
        created = options;
        options.setup({
          on: (event: string, listener: ReturnListener) => {
            if (event === 'return') onReturn = listener;
          },
        });
        return channel;
      },
    },
  } as unknown as AmqpConnection;

  return {
    publisher: new RabbitOutboxPublisher(amqp, CONFIG),
    sent,
    created: () => created,
    closed: () => closed,
  };
}

const record = (overrides: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: '01990000-0000-7000-8000-d00000000001',
  exchange: 'events',
  routingKey: 'orders.order-paid',
  payload: { name: 'orders.order-paid', correlationId: '01990000-0000-7000-8000-d00000000002' },
  ...overrides,
});

const command = (overrides: Partial<OutboxRecord> = {}): OutboxRecord =>
  record({ exchange: 'commands', routingKey: 'payments.charge-payment', ...overrides });

describe('RabbitOutboxPublisher', () => {
  it('OBX-004 publishes on a confirm channel of its own, with the timeout from the config', () => {
    const { created } = brokerWith();

    expect(created()).toMatchObject({ name: 'outbox', confirm: true, publishTimeout: 1234 });
  });

  it('sends the stored envelope as JSON, persistent, routed by the row, with its ids', async () => {
    const { publisher, sent } = brokerWith();
    const row = record();

    await publisher.publish(row);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ exchange: 'events', routingKey: 'orders.order-paid' });
    expect(JSON.parse(sent[0]!.content.toString())).toEqual(row.payload);
    expect(sent[0]!.options).toMatchObject({
      persistent: true,
      messageId: row.id,
      correlationId: '01990000-0000-7000-8000-d00000000002',
    });
  });

  it('OBX-005 publishes a command mandatory and an event not', async () => {
    const { publisher, sent } = brokerWith();

    await publisher.publish(command());
    await publisher.publish(record());

    expect(sent.map((s) => s.options.mandatory)).toEqual([true, false]);
  });

  it('OBX-005 fails a command the broker handed back: no queue is bound for it', async () => {
    const { publisher } = brokerWith({ unroutable: ['payments.charge-payment'] });

    await expect(publisher.publish(command())).rejects.toThrow(UnroutableMessageError);
  });

  it('publishes the same command once its queue exists', async () => {
    const unroutable = ['payments.charge-payment'];
    const { publisher } = brokerWith({ unroutable });
    await expect(publisher.publish(command())).rejects.toThrow(UnroutableMessageError);

    unroutable.length = 0;

    await expect(publisher.publish(command())).resolves.toBeUndefined();
  });

  it('OBX-004 fails when the broker does not confirm in time', async () => {
    const { publisher } = brokerWith({ confirms: false });

    await expect(publisher.publish(record())).rejects.toThrow('timeout');
  });

  it('closes its channel with the module', async () => {
    const { publisher, closed } = brokerWith();

    await publisher.onModuleDestroy();

    expect(closed()).toBe(true);
  });
});
