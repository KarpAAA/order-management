import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import type { DbTransactionAdapter } from '@infra/database/transactional.adapter';

/** What every contract of `@oms/contracts` has; the rest of the envelope is stored as it is. */
export interface OutboxEnvelope {
  messageId: string;
  name: string;
  occurredAt: string;
}

export interface OutboxEntry {
  /** An exchange of `@oms/contracts`; the routing key is the name of the message. */
  exchange: string;
  /** Built by `Contract.create()`: validated before it is stored. */
  message: OutboxEnvelope;
}

/**
 * The write side of the transactional outbox (docs/adr/0014-transactional-outbox.md): a
 * message for the broker becomes a row in the transaction of the change it tells about, so
 * both are committed or neither is. The relay of the worker publishes it afterwards.
 *
 * The id of the row is the `messageId` of the envelope, chosen here and never again: a message
 * the relay publishes twice is the same message to whoever reads it.
 */
@Injectable()
export class Outbox {
  constructor(private readonly txHost: TransactionHost<DbTransactionAdapter>) {}

  async append({ exchange, message }: OutboxEntry): Promise<void> {
    if (!this.txHost.isTransactionActive()) {
      // outside a transaction the row would be one more write next to the change, not part of it
      throw new Error(`Outbox.append(${message.name}) must be called inside a transaction`);
    }
    await this.txHost.tx.outboxMessage.create({
      data: {
        id: message.messageId,
        exchange,
        routingKey: message.name,
        payload: { ...message },
        occurredAt: new Date(message.occurredAt),
      },
    });
  }
}
