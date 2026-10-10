import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import {
  captureTraceContext,
  captureTraceLink,
  type TraceCarrier,
} from '@common/tracing/trace-context';
import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { delayQueue } from '@infra/messaging/delay-topology';
import { DELAYED_EXCHANGE } from '@shared/messaging/delayed';

/** What every contract of `@oms/contracts` has; the rest of the envelope is stored as it is. */
export interface OutboxEnvelope {
  messageId: string;
  name: string;
  occurredAt: string;
}

export interface OutboxEntry {
  /** An exchange of `@oms/contracts`, or the one of this service for delayed messages. */
  exchange: string;
  /** Unset: the name of the message, as for every message between services. */
  routingKey?: string;
  /** Built by `Contract.create()`: validated before it is stored. */
  message: OutboxEnvelope;
}

export interface DelayedOutboxEntry {
  /** The queue of this service that reads the message when its wait is over. */
  queue: string;
  /** One of the delays of that queue in `rabbitConfig.delays`: a queue exists per delay. */
  delayMs: number;
  message: OutboxEnvelope;
}

/**
 * The write side of the transactional outbox (docs/adr/0014-transactional-outbox.md): a
 * message for the broker becomes a row in the transaction of the change it tells about, so
 * both are committed or neither is. The relay of the worker publishes it afterwards.
 *
 * The id of the row is the `messageId` of the envelope, chosen here and never again: a message
 * the relay publishes twice is the same message to whoever reads it.
 *
 * The row keeps the trace it was written in (docs/adr/0025): the relay publishes it from a
 * timer of another process, and the message continues the trace of the request.
 */
@Injectable()
export class Outbox {
  constructor(private readonly txHost: TransactionHost<DbTransactionAdapter>) {}

  append(entry: OutboxEntry): Promise<void> {
    return this.write(entry, captureTraceContext());
  }

  /**
   * A message this service sends to itself for later (a timeout): written with the change
   * that starts the wait, so a wait never begins without the message that ends it. It is
   * published like any other row, to the queue that keeps it for `delayMs`.
   *
   * Its trace is a link, not a parent: what happens when the wait is over is a trace of its
   * own that points back, or the trace of a request would last as long as its timeout.
   */
  appendDelayed({ queue, delayMs, message }: DelayedOutboxEntry): Promise<void> {
    return this.write(
      { exchange: DELAYED_EXCHANGE, routingKey: delayQueue(queue, delayMs), message },
      captureTraceLink(),
    );
  }

  private async write(
    { exchange, routingKey, message }: OutboxEntry,
    traceContext: TraceCarrier | null,
  ): Promise<void> {
    if (!this.txHost.isTransactionActive()) {
      // outside a transaction the row would be one more write next to the change, not part of it
      throw new Error(`Outbox.append(${message.name}) must be called inside @Transactional()`);
    }
    await this.txHost.tx.outboxMessage.create({
      data: {
        id: message.messageId,
        exchange,
        routingKey: routingKey ?? message.name,
        payload: { ...message },
        occurredAt: new Date(message.occurredAt),
        ...(traceContext ? { traceContext: { ...traceContext } } : {}),
      },
    });
  }
}
