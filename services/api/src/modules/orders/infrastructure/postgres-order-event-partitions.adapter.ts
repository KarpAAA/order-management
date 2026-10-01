import { Injectable } from '@nestjs/common';

import { PrismaService } from '@infra/database/prisma.service';
import type { YearMonth } from '@shared/domain/year-month';

import {
  ORDER_EVENTS_TABLE,
  createPartitionSql,
  partitionMonth,
  partitionName,
} from './order-event-partitions.sql';

import type { OrderEventPartitionsPort } from '../ports/order-event-partitions.port';

/**
 * Partition DDL on `order_events`. The unscoped client, on purpose: this is the table's
 * structure, not a tenant's rows, and no workspace is bound when the job runs
 * (docs/architecture.md → Tenancy lists it). Every statement runs on its own, outside a
 * transaction: `DETACH … CONCURRENTLY` requires that.
 */
@Injectable()
export class PostgresOrderEventPartitions implements OrderEventPartitionsPort {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<YearMonth[]> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT child.relname AS name
        FROM pg_inherits
        JOIN pg_class child ON child.oid = pg_inherits.inhrelid
       WHERE pg_inherits.inhparent = to_regclass(${ORDER_EVENTS_TABLE})`;
    return rows.map((row) => partitionMonth(row.name)).filter((month) => month !== null);
  }

  async create(month: YearMonth): Promise<void> {
    await this.prisma.$executeRawUnsafe(createPartitionSql(month));
  }

  /**
   * Detach first, then drop: the detach takes no lock that blocks readers and writers of the
   * other months, a plain DROP of an attached partition locks the whole table. A detach that
   * was interrupted stays pending and can only be finalized.
   */
  async drop(month: YearMonth): Promise<void> {
    const name = partitionName(month);
    const attached = await this.prisma.$queryRaw<{ detaching: boolean }[]>`
      SELECT inhdetachpending AS detaching
        FROM pg_inherits
       WHERE inhrelid = to_regclass(${name}) AND inhparent = to_regclass(${ORDER_EVENTS_TABLE})`;
    const [state] = attached;
    if (state) {
      const mode = state.detaching ? 'FINALIZE' : 'CONCURRENTLY';
      await this.prisma.$executeRawUnsafe(
        `ALTER TABLE "${ORDER_EVENTS_TABLE}" DETACH PARTITION "${name}" ${mode}`,
      );
    }
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${name}"`);
  }
}
