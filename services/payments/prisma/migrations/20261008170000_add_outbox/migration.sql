-- The transactional outbox (docs/adr/0014-transactional-outbox.md): the answer to a command
-- is a row written in the transaction that settles the payment.

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

-- DELETE as well, unlike "payments": a published message is not a record of money, and the
-- retention removes it.
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox" TO payments_app;
