import { Inject, Injectable } from '@nestjs/common';

import { outboxConfig, type OutboxConfig } from '@config/configuration';
import { PrismaService } from '@infra/database/prisma.service';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { CORRELATION, type Correlation } from '@shared/messaging/correlation';

import { correlationIdFrom } from '../correlation/correlation-id';
import { runInTraceContext, traceCarrierFrom } from '../tracing/trace-context';

import { OUTBOX_PUBLISHER, type OutboxPublisher, type OutboxRecord } from './outbox-publisher.port';

/** One relay at a time in this database: the key of its advisory lock ("outbox" in ASCII). */
const RELAY_LOCK = 0x6f7574626f78n;
/** Above the time one pass may take: every message confirmed at once, the last one not at all. */
const TRANSACTION_MARGIN_MS = 15_000;

export interface RelayPass {
  /** Another relay holds the lock: this pass did nothing. */
  skipped: boolean;
  published: number;
  /** A full batch went out: more may be waiting, the next pass should not sleep. */
  more: boolean;
  /** Why the pass stopped before the end of its batch. */
  failure?: unknown;
}

/** The chain a row belongs to: the correlation id of the envelope it holds. */
const correlationOf = (payload: unknown): string => {
  const envelope = typeof payload === 'object' && payload !== null ? payload : {};
  return (
    correlationIdFrom('correlationId' in envelope ? envelope.correlationId : undefined) ?? newId()
  );
};

/**
 * One pass of the relay: takes the oldest unpublished messages, publishes them one by one in
 * the order they were written, and marks the published ones, all in one transaction.
 *
 *  - one relay at a time (`pg_try_advisory_xact_lock`): two would each take a part of the
 *    queue and publish the events of one order out of order. Whoever does not get the lock
 *    skips its pass. The lock is transaction-level, the only kind PgBouncer allows;
 *  - `FOR UPDATE SKIP LOCKED` keeps a row from being taken twice should the lock ever go;
 *  - the first message that fails ends the pass, and every later one waits behind it: order
 *    matters more than throughput;
 *  - a pass that dies after the broker confirmed and before the commit publishes those
 *    messages again: at-least-once, with the same message id.
 *
 * The unscoped client, on purpose: the rows belong to no tenant (docs/adr/0014).
 *
 * The relay has no chain of its own: each row is published under the correlation id of its
 * message, so the line of a publish is found with the request that caused it. The same goes
 * for its trace: a row is published in the trace it was written in (docs/adr/0025).
 */
@Injectable()
export class OutboxRelay {
  private readonly log: Logger;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
    @Inject(outboxConfig.KEY) private readonly config: OutboxConfig,
    @Inject(CORRELATION) private readonly correlation: Correlation,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: OutboxRelay.name });
  }

  pass(): Promise<RelayPass> {
    const { batchSize, publishTimeoutMs } = this.config;
    return this.prisma.$transaction(
      async (tx): Promise<RelayPass> => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${RELAY_LOCK}) AS locked`;
        if (!lock?.locked) return { skipped: true, published: 0, more: false };

        const batch = await tx.$queryRaw<OutboxRecord[]>`
          SELECT id, exchange, routing_key AS "routingKey", payload,
                 trace_context AS "traceContext"
            FROM outbox
           WHERE published_at IS NULL
           ORDER BY id
           LIMIT ${batchSize}
             FOR UPDATE SKIP LOCKED`;

        const published: string[] = [];
        let failure: unknown;
        for (const record of batch) {
          // read back from JSON: whatever is not a carrier is no trace
          const traceContext = traceCarrierFrom(record.traceContext);
          failure = await runInTraceContext(traceContext, () =>
            this.correlation.run(correlationOf(record.payload), () =>
              this.publish({ ...record, traceContext }),
            ),
          );
          if (failure !== undefined) break;
          published.push(record.id);
        }
        if (published.length > 0) {
          await tx.outboxMessage.updateMany({
            where: { id: { in: published } },
            data: { publishedAt: this.clock.now() },
          });
        }
        return {
          skipped: false,
          published: published.length,
          more: failure === undefined && batch.length === batchSize,
          ...(failure === undefined ? {} : { failure }),
        };
      },
      { timeout: publishTimeoutMs + TRANSACTION_MARGIN_MS },
    );
  }

  /** One row to the broker, in the scope of its chain. Resolves with why it failed, if it did. */
  private async publish(record: OutboxRecord): Promise<unknown> {
    const { id: messageId, exchange, routingKey } = record;
    try {
      await this.publisher.publish(record);
    } catch (err: unknown) {
      // every pass meets the same row until it goes out: the runner reports it once, as an error
      this.log.debug({ messageId, exchange, routingKey, err }, 'message not published');
      return err ?? new Error('publish failed');
    }
    this.log.debug({ messageId, exchange, routingKey }, 'message published');
    return undefined;
  }
}
