-- The transactional outbox (docs/adr/0014-transactional-outbox.md): a message for the broker
-- is a row written in the transaction of the change it tells about.

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

-- CreateIndex
CREATE INDEX "outbox_published_at_id_idx" ON "outbox"("published_at", "id");

-- No workspace_id and no Row-Level Security: the relay reads the rows of every tenant, and
-- the tenant of a message is in its envelope. DELETE is for the retention job.
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox" TO oms_app;
