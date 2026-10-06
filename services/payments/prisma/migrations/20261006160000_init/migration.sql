-- The first table of payments-service: one row per payment attempt of an order.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "psp_charge_id" TEXT,
    "failure_code" TEXT,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_order_id_attempt_key" ON "payments"("order_id", "attempt");

-- Constraints Prisma cannot express.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_minor_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "payments_attempt_positive" CHECK ("attempt" > 0),
  ADD CONSTRAINT "payments_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- a row is settled once, and what it holds follows from how it ended
  ADD CONSTRAINT "payments_status_shape" CHECK (
    ("status" = 'PENDING' AND "settled_at" IS NULL AND "psp_charge_id" IS NULL AND "failure_code" IS NULL)
    OR ("status" = 'SUCCEEDED' AND "settled_at" IS NOT NULL AND "psp_charge_id" IS NOT NULL AND "failure_code" IS NULL)
    OR ("status" = 'FAILED' AND "settled_at" IS NOT NULL AND "failure_code" IS NOT NULL)
  );

-- The role the service connects as. It owns nothing and cannot run DDL: the tables belong to
-- the role that runs the migrations. Created without a login; the environment adds one
-- (devtools/postgres-payments/init for the dev stack, the test setup for a run).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'payments_app') THEN
    CREATE ROLE payments_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO payments_app;
-- no DELETE: a payment attempt is a record of money, it is never removed
GRANT SELECT, INSERT, UPDATE ON "payments" TO payments_app;
