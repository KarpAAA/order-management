-- Roadmap 2.2: the plans of the list queries on the db:datagen volume data.
-- Read-only except block 5, which drops indexes inside a transaction and rolls back.
-- Run from the repo root: pnpm db:explain   (report: docs/perf/2.2-indexes-explain.md)
--
-- The SQL mirrors what the query services send through Prisma (columns trimmed): the tenant
-- extension adds `workspace_id = $1`, `afterCursor` adds the cursor (shared/pagination/cursor.ts).

\set ON_ERROR_STOP on
\pset pager off

-- ── 0. Subjects ────────────────────────────────────────────────────────────────
-- the biggest tenant, a small one, and a keyset position 100 000 rows deep (≈ page 5000)
SELECT workspace_id AS big FROM orders GROUP BY 1 ORDER BY count(*) DESC LIMIT 1 \gset
SELECT o.workspace_id AS small FROM orders o JOIN workspaces w ON w.id = o.workspace_id
  WHERE w.slug LIKE 'gen-%' GROUP BY 1 ORDER BY count(*) ASC LIMIT 1 \gset
SELECT created_at AS c_at, id AS c_id FROM orders WHERE workspace_id = :'big'
  ORDER BY created_at DESC, id DESC OFFSET 100000 LIMIT 1 \gset
SELECT order_id AS ord FROM order_events WHERE workspace_id = :'big'
  GROUP BY 1 ORDER BY count(*) DESC LIMIT 1 \gset

\echo big tenant :big, small tenant :small, cursor (:c_at, :c_id), order :ord
SELECT (SELECT count(*) FROM orders WHERE workspace_id = :'big') AS big_orders,
       (SELECT count(*) FROM orders WHERE workspace_id = :'small') AS small_orders;
SELECT status, count(*) FROM orders WHERE workspace_id = :'big' GROUP BY 1 ORDER BY 2 DESC;

-- ── 1. Orders list, newest first (OrdersQueryService.list) ────────────────────
\echo '\n=== 1A first page'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big'
ORDER BY created_at DESC, id DESC LIMIT 21;

\echo '\n=== 1B page ~5000, OR cursor alone (Prisma SQL before the 2.2 fix): the cursor is a Filter'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big'
  AND (created_at < :'c_at' OR (created_at = :'c_at' AND id < :'c_id'))
ORDER BY created_at DESC, id DESC LIMIT 21;

\echo '\n=== 1C page ~5000, OR cursor + redundant bound (Prisma SQL after the fix): Index Cond'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big'
  AND created_at <= :'c_at'
  AND (created_at < :'c_at' OR (created_at = :'c_at' AND id < :'c_id'))
ORDER BY created_at DESC, id DESC LIMIT 21;

\echo '\n=== 1D page ~5000, row comparison (the conventions form; not expressible in Prisma)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big'
  AND (created_at, id) < (:'c_at'::timestamptz, :'c_id'::uuid)
ORDER BY created_at DESC, id DESC LIMIT 21;

\echo '\n=== 1E page ~5000 by OFFSET: reads and discards 100 000 rows'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big'
ORDER BY created_at DESC, id DESC OFFSET 100000 LIMIT 21;

-- ── 2. Orders list filtered by status ─────────────────────────────────────────
\echo '\n=== 2A rare status (PAID): the (workspace, status, created_at, id) index'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big' AND status = 'PAID'
ORDER BY created_at DESC, id DESC LIMIT 21;

\echo '\n=== 2B common status (FULFILLED): the planner may prefer the index without status + Filter'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big' AND status = 'FULFILLED'
ORDER BY created_at DESC, id DESC LIMIT 21;

\echo '\n=== 2C small tenant, any status'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'small' AND status = 'FULFILLED'
ORDER BY created_at DESC, id DESC LIMIT 21;

-- ── 3. Order history (OrdersQueryService.listEvents) ──────────────────────────
\echo '\n=== 3A existence check: count on the primary key'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM orders WHERE workspace_id = :'big' AND id = :'ord';

\echo '\n=== 3B history, oldest first'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, type, from_status, to_status, actor, payload, created_at FROM order_events
WHERE workspace_id = :'big' AND order_id = :'ord'
ORDER BY created_at ASC, id ASC LIMIT 21;

-- ── 4. The other node types, for reading practice ─────────────────────────────
\echo '\n=== 4A Index Only Scan: count by status (Heap Fetches shows the visibility map)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM orders WHERE workspace_id = :'big' AND status = 'PAID';

\echo '\n=== 4B Bitmap Heap Scan: a month of a big tenant, no LIMIT'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total_minor FROM orders
WHERE workspace_id = :'big' AND created_at >= date_trunc('month', :'c_at'::timestamptz);

\echo '\n=== 4C Seq Scan: a filter no index covers'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM orders WHERE workspace_id = :'big' AND total_minor > 50000000;

-- ── 5. Before the indexes: drop them in a transaction, look, roll back ────────
-- DDL is transactional in Postgres. The transaction holds ACCESS EXCLUSIVE on orders:
-- do not run the api against this database meanwhile.
\echo '\n=== 5A-5B without the list indexes (rolled back)'
BEGIN;
DROP INDEX orders_workspace_id_status_created_at_id_idx;
DROP INDEX orders_workspace_id_created_at_id_idx;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big'
ORDER BY created_at DESC, id DESC LIMIT 21;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big' AND status = 'PAID'
ORDER BY created_at DESC, id DESC LIMIT 21;
ROLLBACK;

-- ── 6. Sizes and index usage ──────────────────────────────────────────────────
\echo '\n=== 6 sizes'
SELECT relname,
       n_live_tup,
       pg_size_pretty(pg_relation_size(relid)) AS heap,
       pg_size_pretty(pg_indexes_size(relid)) AS indexes
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;

-- order_events is partitioned since 2.3: its indexes live on the partitions
-- (pnpm db:explain:partitions sums them up)
SELECT relname, indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan
FROM pg_stat_user_indexes
WHERE relname IN ('orders', 'order_items')
ORDER BY pg_relation_size(indexrelid) DESC;
