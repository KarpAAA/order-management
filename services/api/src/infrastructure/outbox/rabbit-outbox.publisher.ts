import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Inject, Injectable } from '@nestjs/common';
import { exchanges } from '@oms/contracts';

import { outboxConfig, type OutboxConfig } from '@config/configuration';

import { UnroutableMessageError } from './unroutable-message.error';

import type { OutboxPublisher, OutboxRecord } from './outbox-publisher.port';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';

// amqp-connection-manager is the library's dependency, not ours: its type comes through it
type ChannelWrapper = AmqpConnection['managedChannel'];

const correlationOf = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { correlationId } = payload as { correlationId?: unknown };
  return typeof correlationId === 'string' ? correlationId : undefined;
};

/**
 * Publishes a row of the outbox to RabbitMQ, on a channel of its own.
 *
 *  - "published" means confirmed: the promise resolves when the broker has the message on
 *    disk, not when it left the socket;
 *  - a broker that is away never answers, so every publish has a timeout;
 *  - a command is published `mandatory`: with no queue bound for it the broker hands it back
 *    instead of dropping it, and the row stays unpublished. So is a delayed message, which
 *    has one reader as well. An event with no subscriber is not a loss, and is not mandatory.
 */
@Injectable()
export class RabbitOutboxPublisher implements OutboxPublisher, OnModuleDestroy {
  private readonly channel: ChannelWrapper;
  /** Ids the broker handed back. A return arrives before the confirm of the same message. */
  private readonly returned = new Set<string>();

  constructor(amqp: AmqpConnection, @Inject(outboxConfig.KEY) config: OutboxConfig) {
    this.channel = amqp.managedConnection.createChannel({
      name: 'outbox',
      confirm: true,
      publishTimeout: config.publishTimeoutMs,
      // runs on every (re)connect: the listener belongs to the channel of that connection
      setup: (channel: Channel) => {
        channel.on('return', (message: ConsumeMessage) => {
          const id: unknown = message.properties.messageId;
          if (typeof id === 'string') this.returned.add(id);
        });
      },
    });
  }

  async publish(record: OutboxRecord): Promise<void> {
    const content = Buffer.from(JSON.stringify(record.payload));
    await this.channel.publish(record.exchange, record.routingKey, content, {
      persistent: true,
      mandatory: record.exchange !== exchanges.events.name,
      messageId: record.id,
      correlationId: correlationOf(record.payload),
    });
    if (this.returned.delete(record.id)) {
      throw new UnroutableMessageError(
        `no queue is bound to ${record.exchange} for ${record.routingKey}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel.close();
  }
}
