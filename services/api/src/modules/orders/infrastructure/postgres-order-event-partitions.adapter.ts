import { Injectable } from '@nestjs/common';

import { PrismaService } from '@infra/database/prisma.service';
import type { YearMonth } from '@shared/domain/year-month';

import { ORDER_EVENTS_TABLE, partitionMonth } from './order-event-partitions.sql';

import type { OrderEventPartitionsPort } from '../ports/order-event-partitions.port';

/**
 * Partition DDL on `order_events`. The unscoped client, on purpose: this is the table's
 * structure, not a tenant's rows, and no workspace is bound when the job runs
 * (docs/architecture.md → Tenancy lists it). The application role does not own the table, so
 * the DDL lives in two SECURITY DEFINER functions it may only call (migration
 * 20261001180000_enable_row_level_security); the months they build are the ones of
 * order-event-partitions.sql.ts.
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

  async create({ year, month }: YearMonth): Promise<void> {
    await this.prisma
      .$executeRaw`SELECT create_order_events_partition(${year}::int, ${month}::int)`;
  }

  /**
   * A plain DROP: it locks the whole table for an instant, and the function gives up after its
   * lock_timeout rather than queue behind a long query. The job's next run tries again.
   */
  async drop({ year, month }: YearMonth): Promise<void> {
    await this.prisma.$executeRaw`SELECT drop_order_events_partition(${year}::int, ${month}::int)`;
  }
}
