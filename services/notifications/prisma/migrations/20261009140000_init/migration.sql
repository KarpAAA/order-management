-- The database of notifications-service (docs/adr/0019-notifications-service.md): the mails
-- the service owes the users of orders, and its inbox.

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "send_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox" (
    "consumer" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("consumer","message_id")
);

-- CreateIndex
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notifications_settled_at_idx" ON "notifications"("settled_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_order_id_kind_attempt_key" ON "notifications"("order_id", "kind", "attempt");

-- CreateIndex
CREATE INDEX "inbox_processed_at_idx" ON "inbox"("processed_at");

-- Constraints Prisma cannot express.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_attempt_not_negative" CHECK ("attempt" >= 0),
  ADD CONSTRAINT "notifications_send_attempts_not_negative" CHECK ("send_attempts" >= 0),
  -- a notification that waits says when it is due, and only it: the dispatcher finds its
  -- work by this column
  ADD CONSTRAINT "notifications_pending_is_due" CHECK (("status" = 'PENDING') = ("next_attempt_at" IS NOT NULL)),
  -- sent or given up once, and only then is there a moment to say so
  ADD CONSTRAINT "notifications_settled_shape" CHECK (("status" = 'PENDING') = ("settled_at" IS NULL));

-- The role the service connects as. It owns nothing and cannot run DDL: the tables belong to
-- the role that runs the migrations. Created without a login; the environment adds one
-- (devtools/postgres-notifications/init for the dev stack, the test setup for a run).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'notifications_app') THEN
    CREATE ROLE notifications_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO notifications_app;
-- DELETE is for the retention: a notification that was sent or given up, and the record of
-- a handled message, are removed after a while
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO notifications_app;
GRANT SELECT, INSERT, DELETE ON "inbox" TO notifications_app;
