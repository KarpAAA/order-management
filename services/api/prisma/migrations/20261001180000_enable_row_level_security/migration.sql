-- Row-Level Security on the tenant tables (docs/adr/0006-row-level-security.md). Hand-written:
-- Prisma cannot express roles, grants, policies or functions, and `migrate diff` does not see
-- them; test/tenancy/row-level-security.int-spec.ts guards them instead.
--
-- Two roles from here on: the owner runs migrations, seed and datagen and sees every row
-- (ENABLE, not FORCE: a backfill must reach all tenants); the application connects as
-- `oms_app`, which owns nothing and sees only the rows of `app.workspace_id`.

-- 1. The application role. Roles are cluster-wide and this runs once per database, hence the
-- guard. NOLOGIN and no password here: the login is the environment's business
-- (devtools/postgres/init, test/setup/global.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oms_app') THEN
    CREATE ROLE oms_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO oms_app;

-- 2. Data access, table by table. No ALTER DEFAULT PRIVILEGES: the partitions of order_events
-- must stay unreachable except through the parent, where the policy applies. A new table
-- needs its own GRANT (and policy) in its migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "users", "workspaces", "memberships", "products", "orders", "order_items", "order_events"
  TO oms_app;

-- 3. The context of the current transaction, set with set_config(…, true) by the tenant choke
-- point. Unset → NULL → no row matches. A setting that was local to an earlier transaction of
-- the same connection reads as '', hence nullif.
CREATE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  RETURN nullif(current_setting('app.workspace_id', true), '')::uuid;

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  RETURN nullif(current_setting('app.user_id', true), '')::uuid;

-- 4. Tenant isolation: USING hides other tenants' rows, WITH CHECK refuses to write them.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "memberships"
  USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());
CREATE POLICY "tenant_isolation" ON "products"
  USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());
CREATE POLICY "tenant_isolation" ON "orders"
  USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());
CREATE POLICY "tenant_isolation" ON "order_items"
  USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());
CREATE POLICY "tenant_isolation" ON "order_events"
  USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());

-- A user reads their own memberships in any workspace: the access guard's lookup before a
-- tenant exists, /me and "my workspaces". Read only; writes stay bound to the tenant.
CREATE POLICY "own_memberships" ON "memberships" FOR SELECT
  USING ("user_id" = app_user_id());

-- 5. Partition maintenance for a role that does not own order_events. SECURITY DEFINER: the
-- body runs as the owner, the application may only call it. Names and bounds are built from
-- two checked integers, the same shape as migration 20261001120000_partition_order_events.
CREATE FUNCTION create_order_events_partition(p_year integer, p_month integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  month_start date;
BEGIN
  IF p_year NOT BETWEEN 2000 AND 2999 OR p_month NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'invalid partition month %-%', p_year, p_month USING ERRCODE = '22023';
  END IF;
  month_start := make_date(p_year, p_month, 1);
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.order_events FOR VALUES FROM (%L) TO (%L)',
    'order_events_' || to_char(month_start, 'YYYY_MM'),
    to_char(month_start, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char(month_start + interval '1 month', 'YYYY-MM-DD') || ' 00:00:00+00'
  );
END $$;

-- A function always runs inside a transaction, so DETACH … CONCURRENTLY is not available: the
-- DROP locks order_events for an instant. lock_timeout turns a long wait into an error, and
-- the next run of the job tries again.
CREATE FUNCTION drop_order_events_partition(p_year integer, p_month integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET lock_timeout = '5s'
AS $$
BEGIN
  IF p_year NOT BETWEEN 2000 AND 2999 OR p_month NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'invalid partition month %-%', p_year, p_month USING ERRCODE = '22023';
  END IF;
  EXECUTE format(
    'DROP TABLE IF EXISTS public.%I',
    'order_events_' || to_char(make_date(p_year, p_month, 1), 'YYYY_MM')
  );
END $$;

REVOKE ALL ON FUNCTION create_order_events_partition(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION drop_order_events_partition(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_order_events_partition(integer, integer) TO oms_app;
GRANT EXECUTE ON FUNCTION drop_order_events_partition(integer, integer) TO oms_app;
