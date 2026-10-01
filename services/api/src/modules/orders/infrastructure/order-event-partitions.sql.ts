// The naming and the bounds of the monthly `order_events` partitions, in one place: the adapter
// and prisma/datagen build the same DDL. Plain strings, no Nest and no Prisma, so a script can
// import it. The same shape is created by the migration 20261001120000_partition_order_events.
import { addMonths } from '@shared/domain/year-month';
import type { YearMonth } from '@shared/domain/year-month';

export const ORDER_EVENTS_TABLE = 'order_events';

const PARTITION_NAME = /^order_events_(\d{4})_(\d{2})$/;
const pad = (month: number): string => String(month).padStart(2, '0');

export const partitionName = ({ year, month }: YearMonth): string =>
  `${ORDER_EVENTS_TABLE}_${String(year)}_${pad(month)}`;

/** The month of a partition name; `null` for a table that is not one of ours. */
export function partitionMonth(name: string): YearMonth | null {
  const match = PARTITION_NAME.exec(name);
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

/** First instant of the month, UTC: the column is timestamptz, the offset is explicit. */
const bound = ({ year, month }: YearMonth): string =>
  `${String(year)}-${pad(month)}-01 00:00:00+00`;

/**
 * Identifiers and partition bounds cannot be bind parameters. Both are built from the two
 * integers of a `YearMonth`, never from input.
 */
export const createPartitionSql = (month: YearMonth): string =>
  `CREATE TABLE IF NOT EXISTS "${partitionName(month)}" PARTITION OF "${ORDER_EVENTS_TABLE}" ` +
  `FOR VALUES FROM ('${bound(month)}') TO ('${bound(addMonths(month, 1))}')`;
