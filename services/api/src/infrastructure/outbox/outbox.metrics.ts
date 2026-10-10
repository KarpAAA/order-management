import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '@infra/database/prisma.service';
import { METRICS, type Metrics } from '@shared/observability/metrics';

import type { OnModuleInit } from '@nestjs/common';

interface Backlog {
  pending: number;
  oldestAgeSeconds: number;
}

/**
 * How far behind the relay is (ops/observability.md §1): the rows it has not published, and
 * the age of the oldest. A relay that is stuck shows here before anybody misses a message.
 *
 * Asked when the metrics are read, one statement on the index of the relay. In the worker
 * only: the backlog is a fact of the table, and one process reports it.
 */
@Injectable()
export class OutboxMetrics implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  onModuleInit(): void {
    // one read of the table for both gauges of a scrape
    let read: Promise<Backlog> | undefined;
    const backlog = (): Promise<Backlog> => {
      read ??= this.backlog().finally(() => {
        read = undefined;
      });
      return read;
    };
    this.metrics.gauge({
      name: 'outbox_pending',
      help: 'Messages written to the outbox and not published yet.',
      collect: async () => [{ labels: {}, value: (await backlog()).pending }],
    });
    this.metrics.gauge({
      name: 'outbox_oldest_age_seconds',
      help: 'Age of the oldest message of the outbox that is not published; 0 when none waits.',
      collect: async () => [{ labels: {}, value: (await backlog()).oldestAgeSeconds }],
    });
  }

  private async backlog(): Promise<Backlog> {
    const [row] = await this.prisma.$queryRaw<Backlog[]>`
      SELECT count(*)::int AS pending,
             COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float8 AS "oldestAgeSeconds"
        FROM outbox
       WHERE published_at IS NULL`;
    return row ?? { pending: 0, oldestAgeSeconds: 0 };
  }
}
