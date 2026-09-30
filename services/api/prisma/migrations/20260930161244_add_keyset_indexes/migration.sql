-- Keyset lists need the full sort key, id tiebreak included (read/query-service.md §4).
-- New indexes first, then the ones they supersede: user_id stays indexed for its FK throughout.
-- Small tables: plain CREATE INDEX (data/migrations.md: CONCURRENTLY above ~1 M rows).

-- CreateIndex
CREATE INDEX "memberships_workspace_id_created_at_id_idx" ON "memberships"("workspace_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "memberships_user_id_created_at_id_idx" ON "memberships"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "order_events_workspace_id_order_id_created_at_id_idx" ON "order_events"("workspace_id", "order_id", "created_at", "id");

-- DropIndex
DROP INDEX "memberships_user_id_idx";

-- DropIndex
DROP INDEX "order_events_workspace_id_order_id_created_at_idx";
