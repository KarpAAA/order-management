// COPY ... FROM STDIN (CSV): the streaming protocol, no SQL parsing per row, no bind-param limit.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { from as copyFrom } from 'pg-copy-streams';

import type { PoolClient } from 'pg';

/** One CSV field. NULL is an empty unquoted field; everything else is quoted. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/** `[db column, row key]`: the COPY column list and where each value comes from. */
export type ColumnMap<T> = readonly (readonly [string, keyof T])[];

export async function copyRows<T>(
  client: PoolClient,
  table: string,
  columns: ColumnMap<T>,
  rows: readonly T[],
): Promise<void> {
  if (rows.length === 0) return;
  const list = columns.map(([column]) => `"${column}"`).join(', ');
  const sql = `COPY "${table}" (${list}) FROM STDIN WITH (FORMAT csv)`;
  const lines = function* (): Generator<string> {
    for (const row of rows) {
      yield `${columns.map(([, key]) => csvField(row[key])).join(',')}\n`;
    }
  };
  await pipeline(Readable.from(lines()), client.query(copyFrom(sql)));
}
