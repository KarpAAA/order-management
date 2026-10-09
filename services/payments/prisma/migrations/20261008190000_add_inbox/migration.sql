-- The inbox (docs/adr/0015-idempotent-consumers.md): a command this service has handled is a
-- row written in the transaction that settles the payment and writes the answer.

-- CreateTable
CREATE TABLE "inbox" (
    "consumer" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("consumer", "message_id")
);

-- CreateIndex
CREATE INDEX "inbox_processed_at_idx" ON "inbox"("processed_at");

-- Not partitioned: the primary key would have to include the time, and the same message
-- handled later would no longer be a duplicate. DELETE is for the retention; no UPDATE: a
-- row is written once.
GRANT SELECT, INSERT, DELETE ON "inbox" TO payments_app;
