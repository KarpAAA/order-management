-- The idempotency keys of the HTTP API (docs/adr/0018-http-idempotency-key.md): a write the
-- API has answered is a row under the key its client chose, written in the transaction of the
-- write. The same key again gets the same answer.

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "user_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("user_id","scope","key")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constraints Prisma cannot express.
ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_status_code_chk" CHECK ("status_code" BETWEEN 200 AND 299);

-- No workspace_id and no Row-Level Security: a key belongs to its user and its route (the
-- path names the workspace), a lookup always carries the user, and the cleanup deletes the
-- keys of everybody. Not partitioned: the primary key would have to include the time, and
-- the same key sent later would no longer be found (as the inbox, ADR 0015).
-- No UPDATE: a row is written once. DELETE is for the retention job.
GRANT SELECT, INSERT, DELETE ON "idempotency_keys" TO oms_app;
