import { Inject, Injectable } from '@nestjs/common';

import { outboxConfig, type OutboxConfig } from '@config/configuration';
import { PrismaService } from '@infra/database/prisma.service';
import { Clock } from '@shared/domain/clock';

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
 */
@Injectable()
export class OutboxRelay {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
    @Inject(outboxConfig.KEY) private readonly config: OutboxConfig,
  ) {}

  pass(): Promise<RelayPass> {
    const { batchSize, publishTimeoutMs } = this.config;
    return this.prisma.$transaction(
      async (tx): Promise<RelayPass> => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${RELAY_LOCK}) AS locked`;
        if (!lock?.locked) return { skipped: true, published: 0, more: false };

        const batch = await tx.$queryRaw<OutboxRecord[]>`
          SELECT id, exchange, routing_key AS "routingKey", payload
            FROM outbox
           WHERE published_at IS NULL
           ORDER BY id
           LIMIT ${batchSize}
             FOR UPDATE SKIP LOCKED`;

        const published: string[] = [];
        let failure: unknown;
        for (const record of batch) {
          try {
            await this.publisher.publish(record);
            published.push(record.id);
          } catch (err: unknown) {
            failure = err ?? new Error('publish failed');
            break;
          }
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
}
