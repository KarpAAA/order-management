-- The database of inventory-service (docs/adr/0016-inventory-service.md): the stock of a
-- product, what an attempt of an order holds of it, and the outbox and inbox of the service.

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('RESERVED', 'REJECTED', 'RELEASED');

-- CreateTable
CREATE TABLE "stock_items" (
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("workspace_id","product_id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_lines" (
    "reservation_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "available" INTEGER,

    CONSTRAINT "reservation_lines_pkey" PRIMARY KEY ("reservation_id","product_id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "exchange" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox" (
    "consumer" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("consumer","message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservations_order_id_attempt_key" ON "reservations"("order_id", "attempt");

-- CreateIndex
CREATE INDEX "outbox_published_at_id_idx" ON "outbox"("published_at", "id");

-- CreateIndex
CREATE INDEX "inbox_processed_at_idx" ON "inbox"("processed_at");

-- AddForeignKey
ALTER TABLE "reservation_lines" ADD CONSTRAINT "reservation_lines_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints Prisma cannot express.
-- The last line of defence: whatever the code does, more is never held than there is.
ALTER TABLE "stock_items"
  ADD CONSTRAINT "stock_items_levels" CHECK ("on_hand" >= 0 AND "reserved" >= 0 AND "reserved" <= "on_hand");

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_attempt_positive" CHECK ("attempt" > 0),
  -- released once, and only a released reservation says when
  ADD CONSTRAINT "reservations_status_shape" CHECK (("status" = 'RELEASED') = ("released_at" IS NOT NULL));

ALTER TABLE "reservation_lines"
  ADD CONSTRAINT "reservation_lines_quantity_positive" CHECK ("quantity" > 0),
  -- recorded only on a line that fell short
  ADD CONSTRAINT "reservation_lines_available_short" CHECK ("available" IS NULL OR ("available" >= 0 AND "available" < "quantity"));

-- The role the service connects as. It owns nothing and cannot run DDL: the tables belong to
-- the role that runs the migrations. Created without a login; the environment adds one
-- (devtools/postgres-inventory/init for the dev stack, the test setup for a run).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'inventory_app') THEN
    CREATE ROLE inventory_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO inventory_app;
GRANT SELECT, INSERT, UPDATE ON "stock_items" TO inventory_app;
-- no DELETE: a reservation is the record of what an order was promised
GRANT SELECT, INSERT, UPDATE ON "reservations" TO inventory_app;
-- written with its reservation and never changed
GRANT SELECT, INSERT ON "reservation_lines" TO inventory_app;
-- DELETE is for the retention: a published message and the record of a handled one are removed
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox" TO inventory_app;
GRANT SELECT, INSERT, DELETE ON "inbox" TO inventory_app;
