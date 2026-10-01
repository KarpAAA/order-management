-- Roadmap 2.3: order_events partitioned by month — pruning, and DROP of a partition vs DELETE.
-- Read-only: blocks 3 and 4 change data and structure inside a transaction and roll back.
-- Run from the repo root: pnpm db:explain:partitions   (report: docs/perf/2.3-partitioning.md)
-- Needs the db:datagen volume data.

\set ON_ERROR_STOP on
\pset pager off

-- ── 0. Subjects ────────────────────────────────────────────────────────────────
-- the biggest tenant, its order with the longest history, and the oldest full month of data
SELECT workspace_id AS big FROM orders GROUP BY 1 ORDER BY count(*) DESC LIMIT 1 \gset
SELECT order_id AS ord FROM order_events WHERE workspace_id = :'big'
  GROUP BY 1 ORDER BY count(*) DESC LIMIT 1 \gset
SELECT created_at AS o_created, updated_at AS o_updated FROM orders
  WHERE workspace_id = :'big' AND id = :'ord' \gset
SELECT date_trunc('month', min(created_at) AT TIME ZONE 'UTC') + interval '1 month' AS month_start
  FROM order_events \gset
SELECT (:'month_start'::timestamp + interval '1 month') AS month_end \gset
SELECT 'order_events_' || to_char(:'month_start'::timestamp, 'YYYY_MM') AS old_part \gset
SELECT 'order_events_' || to_char(:'month_end'::timestamp, 'YYYY_MM') AS next_part \gset

\echo tenant :big, order :ord (:o_created … :o_updated), month :month_start, partition :old_part

\echo '\n=== 0 partitions'
SELECT c.relname AS partition, pg_get_expr(c.relpartbound, c.oid) AS bounds
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = 'order_events'::regclass ORDER BY c.relname;

-- ── 1. Order history (OrdersQueryService.listEvents) ──────────────────────────
\echo '\n=== 1A history by order_id alone (before 2.3): no bound on the partition key, every partition is probed'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, type, from_status, to_status, actor, payload, created_at FROM order_events
WHERE workspace_id = :'big' AND order_id = :'ord'
ORDER BY created_at ASC, id ASC LIMIT 21;

\echo '\n=== 1B history with the order''s time range (what the query service sends): pruned at plan time'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, type, from_status, to_status, actor, payload, created_at FROM order_events
WHERE workspace_id = :'big' AND order_id = :'ord'
  AND created_at >= :'o_created'::timestamptz - interval '1 hour'
  AND created_at <= :'o_updated'::timestamptz + interval '1 hour'
ORDER BY created_at ASC, id ASC LIMIT 21;

\echo '\n=== 1C the same as a prepared statement with a generic plan: pruned at execution (Subplans Removed)'
SET plan_cache_mode = force_generic_plan;
PREPARE history(uuid, uuid, timestamptz, timestamptz) AS
SELECT id, type, from_status, to_status, actor, payload, created_at FROM order_events
WHERE workspace_id = $1 AND order_id = $2 AND created_at >= $3 AND created_at <= $4
ORDER BY created_at ASC, id ASC LIMIT 21;
EXPLAIN (ANALYZE, BUFFERS)
EXECUTE history(:'big', :'ord', :'o_created'::timestamptz - interval '1 hour', :'o_updated'::timestamptz + interval '1 hour');
DEALLOCATE history;
RESET plan_cache_mode;

\echo '\n=== 1D pruning switched off: the planner behaves as if the bounds said nothing'
SET enable_partition_pruning = off;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, type, from_status, to_status, actor, payload, created_at FROM order_events
WHERE workspace_id = :'big' AND order_id = :'ord'
  AND created_at >= :'o_created'::timestamptz - interval '1 hour'
  AND created_at <= :'o_updated'::timestamptz + interval '1 hour'
ORDER BY created_at ASC, id ASC LIMIT 21;
RESET enable_partition_pruning;

-- ── 2. A time range: one tenant, one month ────────────────────────────────────
\echo '\n=== 2A events of the big tenant in one month: one partition instead of the whole primary key'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM order_events
WHERE workspace_id = :'big'
  AND created_at >= :'month_start'::timestamp AT TIME ZONE 'UTC'
  AND created_at <  :'month_end'::timestamp AT TIME ZONE 'UTC';

-- ── 3. Retention by DELETE (rolled back) ──────────────────────────────────────
-- The rows go one by one: each is WAL-logged and marked dead; the heap and the indexes keep
-- their size until VACUUM, and even then the file is not returned to the OS.
\echo '\n=== 3 retention by DELETE: one month, row by row'
SELECT count(*) AS rows_in_month, pg_size_pretty(pg_total_relation_size(:'old_part')) AS size_before
FROM order_events
WHERE created_at >= :'month_start'::timestamp AT TIME ZONE 'UTC'
  AND created_at <  :'month_end'::timestamp AT TIME ZONE 'UTC';
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, WAL)
DELETE FROM order_events
WHERE created_at >= :'month_start'::timestamp AT TIME ZONE 'UTC'
  AND created_at <  :'month_end'::timestamp AT TIME ZONE 'UTC';
SELECT pg_size_pretty(pg_total_relation_size(:'old_part')) AS size_after_delete;
ROLLBACK;

-- ── 4. Retention by DROP (rolled back) ────────────────────────────────────────
-- DDL is transactional in Postgres, so the drop can be timed and undone. The transaction holds
-- ACCESS EXCLUSIVE on order_events until the rollback: do not run the api meanwhile. The worker
-- job detaches CONCURRENTLY first, which cannot run in a transaction and takes no such lock.
\echo '\n=== 4 retention by DROP: the next month, the whole partition at once'
SELECT pg_size_pretty(pg_total_relation_size(:'next_part')) AS size_before;
\timing on
BEGIN;
DROP TABLE :"next_part";
ROLLBACK;
\timing off

-- ── 5. Sizes ──────────────────────────────────────────────────────────────────
\echo '\n=== 5 sizes: the whole table, then per partition'
SELECT count(*) AS partitions,
       pg_size_pretty(sum(pg_relation_size(i.inhrelid))) AS heap,
       pg_size_pretty(sum(pg_indexes_size(i.inhrelid))) AS indexes,
       pg_size_pretty(sum(pg_total_relation_size(i.inhrelid))) AS total
FROM pg_inherits i WHERE i.inhparent = 'order_events'::regclass;

SELECT pindex.relname AS index, pg_size_pretty(sum(pg_relation_size(ii.inhrelid))) AS size,
       pg_size_pretty(max(pg_relation_size(ii.inhrelid))) AS largest_partition
FROM pg_inherits ii JOIN pg_class pindex ON pindex.oid = ii.inhparent
WHERE pindex.relkind = 'I' AND pindex.relname LIKE 'order_events%' GROUP BY 1 ORDER BY sum(pg_relation_size(ii.inhrelid)) DESC;

SELECT c.relname AS partition, c.reltuples::bigint AS rows,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = 'order_events'::regclass ORDER BY c.relname;
