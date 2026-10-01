-- order_events becomes PARTITION BY RANGE (created_at): one partition per calendar month (UTC),
-- named order_events_YYYY_MM. Hand-written: Prisma cannot express partitioning, the model in
-- schema.prisma describes the table as ordinary (data/migrations.md §4).
-- Later partitions are created by the orders worker job (maintain-order-event-partitions),
-- not by migrations. There is no DEFAULT partition: an insert into a month without a partition
-- is a write error (data/db-general.md §9).
--
-- A plain table cannot be altered into a partitioned one, so the rows are copied. That is fine
-- for the seed and for a regenerable datagen database; on a live table of this size the old
-- table would be attached as one big partition in a maintenance window instead.

-- 1. Move the old table out of the way. Index names are unique per schema.
ALTER TABLE "order_events" RENAME TO "order_events_old";
ALTER TABLE "order_events_old" RENAME CONSTRAINT "order_events_pkey" TO "order_events_old_pkey";
ALTER INDEX "order_events_workspace_id_order_id_created_at_id_idx" RENAME TO "order_events_old_workspace_id_order_id_created_at_id_idx";

-- 2. The partitioned table: same columns, key, index and foreign keys, same names.
CREATE TABLE "order_events" (
    "workspace_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" "OrderEventType" NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "actor" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("workspace_id","id","created_at")
) PARTITION BY RANGE ("created_at");

CREATE INDEX "order_events_workspace_id_order_id_created_at_id_idx" ON "order_events"("workspace_id", "order_id", "created_at", "id");

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_workspace_id_order_id_fkey" FOREIGN KEY ("workspace_id", "order_id") REFERENCES "orders"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Partitions: from the oldest existing row (at least the previous month) to three months
-- ahead. Month arithmetic on a UTC `timestamp`, so the session time zone cannot shift a bound.
DO $$
DECLARE
  month_start timestamp;
  last_month  timestamp := date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 months';
BEGIN
  SELECT date_trunc('month', least(min("created_at"), now() - interval '1 month') AT TIME ZONE 'UTC')
    INTO month_start
    FROM "order_events_old";

  WHILE month_start <= last_month LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "order_events" FOR VALUES FROM (%L) TO (%L)',
      'order_events_' || to_char(month_start, 'YYYY_MM'),
      to_char(month_start, 'YYYY-MM-DD') || ' 00:00:00+00',
      to_char(month_start + interval '1 month', 'YYYY-MM-DD') || ' 00:00:00+00'
    );
    month_start := month_start + interval '1 month';
  END LOOP;
END $$;

-- 4. Copy and drop the old table (its key, index and foreign keys go with it).
INSERT INTO "order_events" SELECT * FROM "order_events_old";

DROP TABLE "order_events_old";
