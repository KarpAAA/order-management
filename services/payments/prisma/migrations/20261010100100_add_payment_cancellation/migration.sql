-- What a CANCELLED payment holds (docs/adr/0017-order-saga.md).
--  - The cancellation may be the first thing the service hears of an attempt: its row is
--    then written without an amount, and the charge command that comes later charges nothing.
--  - The provider may have charged while the cancellation was handled: the row keeps the
--    charge id until the provider has taken the charge back (`voided_at`).

-- AlterTable
ALTER TABLE "payments"
  ADD COLUMN "voided_at" TIMESTAMPTZ(3),
  ALTER COLUMN "amount_minor" DROP NOT NULL,
  ALTER COLUMN "currency" DROP NOT NULL,
  ALTER COLUMN "idempotency_key" DROP NOT NULL;

-- Constraints Prisma cannot express.
ALTER TABLE "payments"
  DROP CONSTRAINT "payments_status_shape",
  ADD CONSTRAINT "payments_status_shape" CHECK (
    ("status" = 'PENDING' AND "settled_at" IS NULL AND "psp_charge_id" IS NULL AND "failure_code" IS NULL)
    OR ("status" = 'SUCCEEDED' AND "settled_at" IS NOT NULL AND "psp_charge_id" IS NOT NULL AND "failure_code" IS NULL)
    OR ("status" = 'FAILED' AND "settled_at" IS NOT NULL AND "failure_code" IS NOT NULL)
    OR ("status" = 'CANCELLED' AND "settled_at" IS NOT NULL AND "failure_code" IS NULL)
  ),
  -- only a cancellation that came before its charge command has nothing to charge
  ADD CONSTRAINT "payments_charge_known" CHECK (
    "status" = 'CANCELLED'
    OR ("amount_minor" IS NOT NULL AND "currency" IS NOT NULL AND "idempotency_key" IS NOT NULL)
  ),
  -- only a charge that was made after its cancellation is taken back
  ADD CONSTRAINT "payments_voided_shape" CHECK (
    "voided_at" IS NULL OR ("status" = 'CANCELLED' AND "psp_charge_id" IS NOT NULL)
  );
