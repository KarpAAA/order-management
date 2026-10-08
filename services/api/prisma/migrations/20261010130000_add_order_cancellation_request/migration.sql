-- Cancelling an order while its saga runs (docs/adr/0017-order-saga.md): the request is
-- remembered on the saga until payments has said whether the charge was made, and the history
-- of the order says that it was asked.

-- AlterEnum
-- Not used in this migration: a value cannot be used in the transaction that adds it.
ALTER TYPE "OrderEventType" ADD VALUE 'CANCELLATION_REQUESTED';

-- AlterTable
ALTER TABLE "order_sagas" ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(3);
