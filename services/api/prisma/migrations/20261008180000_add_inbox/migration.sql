-- The inbox (docs/adr/0015-idempotent-consumers.md): a broker message a consumer has handled
-- is a row written in the transaction of what the message caused.

-- CreateTable
CREATE TABLE "inbox" (
    "consumer" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("consumer", "message_id")
);

-- CreateIndex
CREATE INDEX "inbox_processed_at_idx" ON "inbox"("processed_at");

-- No workspace_id and no Row-Level Security: a row holds no data of a tenant, and the cleanup
-- deletes the rows of every tenant. Not partitioned: the primary key would have to include
-- the time, and the same message handled later would no longer be a duplicate.
-- No UPDATE: a row is written once.
GRANT SELECT, INSERT, DELETE ON "inbox" TO oms_app;
