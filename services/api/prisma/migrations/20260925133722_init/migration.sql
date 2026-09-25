-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('NONE', 'PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('ORDER_CREATED', 'ORDER_PLACED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'ORDER_FULFILLED', 'ORDER_CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "workspace_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("workspace_id","id")
);

-- CreateTable
CREATE TABLE "products" (
    "workspace_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_minor" BIGINT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("workspace_id","id")
);

-- CreateTable
CREATE TABLE "orders" (
    "workspace_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "discount_type" "DiscountType" NOT NULL,
    "discount_value_bps" INTEGER,
    "discount_value_minor" BIGINT,
    "tax_rate_bps" INTEGER NOT NULL,
    "subtotal_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "payment_attempt" INTEGER NOT NULL,
    "psp_charge_id" TEXT,
    "failure_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "placed_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "fulfilled_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("workspace_id","id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "workspace_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("workspace_id","id")
);

-- CreateTable
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
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspace_id_user_id_key" ON "memberships"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "products_workspace_id_created_at_id_idx" ON "products"("workspace_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "products_workspace_id_status_created_at_id_idx" ON "products"("workspace_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "products_workspace_id_sku_key" ON "products"("workspace_id", "sku");

-- CreateIndex
CREATE INDEX "orders_workspace_id_created_at_id_idx" ON "orders"("workspace_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "orders_workspace_id_status_created_at_id_idx" ON "orders"("workspace_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "orders_created_by_idx" ON "orders"("created_by");

-- CreateIndex
CREATE INDEX "order_items_workspace_id_order_id_idx" ON "order_items"("workspace_id", "order_id");

-- CreateIndex
CREATE INDEX "order_items_workspace_id_product_id_idx" ON "order_items"("workspace_id", "product_id");

-- CreateIndex
CREATE INDEX "order_events_workspace_id_order_id_created_at_idx" ON "order_events"("workspace_id", "order_id", "created_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_workspace_id_order_id_fkey" FOREIGN KEY ("workspace_id", "order_id") REFERENCES "orders"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_workspace_id_product_id_fkey" FOREIGN KEY ("workspace_id", "product_id") REFERENCES "products"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_workspace_id_order_id_fkey" FOREIGN KEY ("workspace_id", "order_id") REFERENCES "orders"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-written: CHECK constraints (Prisma cannot express them) ──────────────
-- The domain validates first; the database is the last line (data/db-general.md §4).

-- email is stored lower-cased; this makes the unique index case-insensitive
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_chk" CHECK ("email" = lower("email"));

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "workspaces_tax_rate_bps_chk" CHECK ("tax_rate_bps" BETWEEN 0 AND 5000);

ALTER TABLE "products"
  ADD CONSTRAINT "products_price_minor_chk" CHECK ("price_minor" BETWEEN 1 AND 100000000);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "orders_tax_rate_bps_chk" CHECK ("tax_rate_bps" BETWEEN 0 AND 5000),
  ADD CONSTRAINT "orders_discount_shape_chk" CHECK (
    ("discount_type" = 'NONE'    AND "discount_value_bps" IS NULL AND "discount_value_minor" IS NULL) OR
    ("discount_type" = 'PERCENT' AND "discount_value_bps" BETWEEN 0 AND 10000 AND "discount_value_minor" IS NULL) OR
    ("discount_type" = 'FIXED'   AND "discount_value_bps" IS NULL AND "discount_value_minor" >= 0)
  ),
  ADD CONSTRAINT "orders_amounts_chk" CHECK (
    "subtotal_minor" >= 0 AND "discount_minor" >= 0 AND "discount_minor" <= "subtotal_minor"
    AND "tax_minor" >= 0 AND "total_minor" >= 0
    AND "total_minor" = "subtotal_minor" - "discount_minor" + "tax_minor"
  ),
  ADD CONSTRAINT "orders_payment_attempt_chk" CHECK ("payment_attempt" >= 0),
  ADD CONSTRAINT "orders_version_chk" CHECK ("version" >= 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_chk" CHECK ("quantity" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "order_items_unit_price_chk" CHECK ("unit_price_minor" BETWEEN 1 AND 100000000),
  ADD CONSTRAINT "order_items_line_total_chk" CHECK ("line_total_minor" = "unit_price_minor" * "quantity"),
  ADD CONSTRAINT "order_items_position_chk" CHECK ("position" BETWEEN 0 AND 49);
