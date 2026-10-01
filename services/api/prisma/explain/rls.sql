-- Roadmap 2.4: Row-Level Security on the db:datagen volume data, seen from psql.
-- Read-only. Run from the repo root: pnpm db:explain:rls   (report: docs/perf/2.4-rls.md)
--
-- psql connects as the owner; `SET ROLE oms_app` makes the rest of the session the application
-- role, for which the policies apply. The SQL mirrors the orders list of OrdersQueryService.

\set ON_ERROR_STOP on
\pset pager off

-- ── 0. Subjects (as the owner: sees every tenant) ──────────────────────────────
SELECT workspace_id AS big FROM orders GROUP BY 1 ORDER BY count(*) DESC LIMIT 1 \gset
SELECT o.workspace_id AS small FROM orders o JOIN workspaces w ON w.id = o.workspace_id
  WHERE w.slug LIKE 'gen-%' GROUP BY 1 ORDER BY count(*) ASC LIMIT 1 \gset
SELECT order_id AS ord, min(created_at) AS ord_from, max(created_at) AS ord_to
  FROM order_events WHERE workspace_id = :'big'
  GROUP BY 1 ORDER BY count(*) DESC LIMIT 1 \gset
SELECT count(*) AS all_orders FROM orders \gset
\echo big tenant :big, small tenant :small, :all_orders orders in total

\echo '\n=== 0 baseline as the owner: explicit filter, no policy'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big'
ORDER BY created_at DESC, id DESC LIMIT 21;

SET ROLE oms_app;

-- ── 1. What the role sees ──────────────────────────────────────────────────────
\echo '\n=== 1A no tenant in the transaction: nothing'
SELECT count(*) AS orders_without_tenant FROM orders;

\echo '\n=== 1B the big tenant, then the small one: the same query, no filter in it'
BEGIN;
SELECT set_config('app.workspace_id', :'big', true) \g /dev/null
SELECT count(*) AS orders_of_big FROM orders;
COMMIT;
BEGIN;
SELECT set_config('app.workspace_id', :'small', true) \g /dev/null
SELECT count(*) AS orders_of_small FROM orders;
COMMIT;

\echo '\n=== 1C after COMMIT the connection carries no tenant'
SELECT count(*) AS orders_after_commit FROM orders;

-- ── 2. Plans under the policy ──────────────────────────────────────────────────
BEGIN;
SELECT set_config('app.workspace_id', :'big', true) \g /dev/null

\echo '\n=== 2A orders list as the application sends it: its own filter + the policy'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
WHERE workspace_id = :'big'
ORDER BY created_at DESC, id DESC LIMIT 21;

\echo '\n=== 2B the same list with the filter removed: the policy alone must reach the index'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, currency, total_minor FROM orders
ORDER BY created_at DESC, id DESC LIMIT 21;

\echo '\n=== 2C history of one order: partition pruning still works through the policy'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, type, created_at FROM order_events
WHERE workspace_id = :'big' AND order_id = :'ord'
  AND created_at >= :'ord_from' AND created_at <= :'ord_to'
ORDER BY created_at, id LIMIT 21;
COMMIT;

-- ── 3. The price of the frame ──────────────────────────────────────────────────
\echo '\n=== 3 BEGIN + set_config + COMMIT around every tenant query outside @Transactional()'
\timing on
BEGIN;
SELECT set_config('app.workspace_id', :'big', true) \g /dev/null
COMMIT;
\timing off

RESET ROLE;
