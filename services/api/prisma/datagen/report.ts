// Fresh planner statistics and the numbers every Step 2 experiment starts from.
import type { Pool } from 'pg';

const TENANT_TABLES = ['memberships', 'products', 'orders', 'order_items', 'order_events'];

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  // pg returns strings for bigint/numeric and counts; anything else is shown as JSON
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A plain aligned text table: numbers right-aligned, the rest left-aligned. */
function formatTable(rows: readonly Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return '(no rows)\n';
  const headers = Object.keys(first);
  const body = rows.map((row) => headers.map((h) => cell(row[h])));
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const numeric = headers.map((_, i) => body.every((r) => /^-?[\d.]+$/.test(r[i] ?? '')));
  const line = (values: readonly string[]) =>
    values
      .map((v, i) => (numeric[i] ? v.padStart(widths[i] ?? 0) : v.padEnd(widths[i] ?? 0)))
      .join('  ');
  return (
    [line(headers), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n') + '\n'
  );
}

async function print(pool: Pool, title: string, sql: string): Promise<void> {
  const { rows } = await pool.query<Record<string, unknown>>(sql);
  process.stdout.write(`\n${title}\n${formatTable(rows)}`);
}

/** A partition counts towards its parent: order_events is one line, like before partitioning. */
async function reportSizes(pool: Pool): Promise<void> {
  await print(
    pool,
    'Table sizes',
    `SELECT coalesce(parent.relname, t.relname) AS table,
            sum(t.n_live_tup) AS rows,
            pg_size_pretty(sum(pg_relation_size(t.relid))) AS heap,
            pg_size_pretty(sum(pg_indexes_size(t.relid))) AS indexes,
            pg_size_pretty(sum(pg_total_relation_size(t.relid))) AS total,
            count(parent.oid) AS partitions
       FROM pg_stat_user_tables t
       LEFT JOIN pg_inherits i ON i.inhrelid = t.relid
       LEFT JOIN pg_class parent ON parent.oid = i.inhparent
      WHERE t.schemaname = 'public' AND t.relname <> '_prisma_migrations'
      GROUP BY 1
      ORDER BY sum(pg_total_relation_size(t.relid)) DESC`,
  );
  await print(
    pool,
    'Index sizes',
    `SELECT coalesce(ptable.relname, s.relname) AS table,
            coalesce(pindex.relname, s.indexrelname) AS index,
            pg_size_pretty(sum(pg_relation_size(s.indexrelid))) AS size
       FROM pg_stat_user_indexes s
       LEFT JOIN pg_inherits ti ON ti.inhrelid = s.relid
       LEFT JOIN pg_class ptable ON ptable.oid = ti.inhparent
       LEFT JOIN pg_inherits ii ON ii.inhrelid = s.indexrelid
       LEFT JOIN pg_class pindex ON pindex.oid = ii.inhparent
      WHERE s.schemaname = 'public' AND s.relname <> '_prisma_migrations'
      GROUP BY 1, 2
      ORDER BY sum(pg_relation_size(s.indexrelid)) DESC`,
  );
  await print(
    pool,
    'order_events partitions (non-empty)',
    `SELECT t.relname AS partition,
            t.n_live_tup AS rows,
            pg_size_pretty(pg_relation_size(t.relid)) AS heap,
            pg_size_pretty(pg_indexes_size(t.relid)) AS indexes
       FROM pg_stat_user_tables t
       JOIN pg_inherits i ON i.inhrelid = t.relid
      WHERE i.inhparent = 'order_events'::regclass AND t.n_live_tup > 0
      ORDER BY t.relname`,
  );
}

export async function analyzeAndReport(pool: Pool): Promise<void> {
  // without ANALYZE the planner works from empty-table statistics and EXPLAIN lies
  await pool.query(`VACUUM (ANALYZE) ${TENANT_TABLES.map((t) => `"${t}"`).join(', ')}`);

  await reportSizes(pool);
  await print(
    pool,
    'Top 10 tenants by orders',
    `SELECT w.slug, count(*) AS orders,
            round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
       FROM orders o JOIN workspaces w ON w.id = o.workspace_id
      GROUP BY w.slug ORDER BY count(*) DESC LIMIT 10`,
  );
  await print(
    pool,
    'Orders by status',
    `SELECT status, count(*) AS orders FROM orders GROUP BY status ORDER BY count(*) DESC`,
  );
}
