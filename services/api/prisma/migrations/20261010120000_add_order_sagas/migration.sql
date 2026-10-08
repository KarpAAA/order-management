-- The saga of an order (docs/adr/0017-order-saga.md): where one placing of an order is in its
-- process across inventory and payments, one row per payment attempt.

-- AlterEnum
-- What the saga writes into the history of an order. The new values are not used in this
-- migration: a value cannot be used in the transaction that adds it.
ALTER TYPE "OrderEventType" ADD VALUE 'STOCK_RESERVED';
ALTER TYPE "OrderEventType" ADD VALUE 'STOCK_RESERVATION_FAILED';
ALTER TYPE "OrderEventType" ADD VALUE 'STOCK_RELEASED';
ALTER TYPE "OrderEventType" ADD VALUE 'PAYMENT_TIMED_OUT';

-- CreateEnum
CREATE TYPE "OrderSagaStep" AS ENUM ('RESERVING', 'CHARGING', 'CANCELLING_PAYMENT', 'RELEASING', 'COMPLETED', 'ABORTED');

-- CreateTable
CREATE TABLE "order_sagas" (
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "step" "OrderSagaStep" NOT NULL,
    "deadline_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_sagas_pkey" PRIMARY KEY ("workspace_id","order_id","attempt")
);

-- AddForeignKey
ALTER TABLE "order_sagas" ADD CONSTRAINT "order_sagas_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_sagas" ADD CONSTRAINT "order_sagas_workspace_id_order_id_fkey" FOREIGN KEY ("workspace_id", "order_id") REFERENCES "orders"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constraints Prisma cannot express.
ALTER TABLE "order_sagas"
  ADD CONSTRAINT "order_sagas_attempt_chk" CHECK ("attempt" > 0),
  -- a step that waits has a deadline, a saga that has ended has none
  ADD CONSTRAINT "order_sagas_deadline_chk" CHECK (
    ("step" IN ('COMPLETED', 'ABORTED')) = ("deadline_at" IS NULL)
  );

-- A tenant table (docs/adr/0006-row-level-security.md): `migrate diff` sees neither the grant
-- nor the policy, test/tenancy/row-level-security.int-spec.ts does. No DELETE: a saga goes
-- with its order, through the foreign key.
GRANT SELECT, INSERT, UPDATE ON "order_sagas" TO oms_app;
ALTER TABLE "order_sagas" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order_sagas"
  USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());

-- Orders that are PENDING_PAYMENT now have asked for their charge and wait for its outcome:
-- that is a saga in CHARGING. Nothing was reserved for them, and no timeout is under way; the
-- answer of payments ends them, or a cancellation. Few rows, so in the migration
-- (data/migrations.md §5).
INSERT INTO "order_sagas"
  ("workspace_id", "order_id", "attempt", "step", "deadline_at", "version", "created_at", "updated_at")
SELECT "workspace_id", "id", "payment_attempt", 'CHARGING', CURRENT_TIMESTAMP, 0,
       COALESCE("placed_at", "updated_at"), CURRENT_TIMESTAMP
  FROM "orders"
 WHERE "status" = 'PENDING_PAYMENT';
