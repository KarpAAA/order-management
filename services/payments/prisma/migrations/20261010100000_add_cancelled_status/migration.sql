-- A payment attempt can be cancelled before it is charged (docs/adr/0017-order-saga.md).
-- Alone in its migration: a new enum value cannot be used in the transaction that adds it,
-- and the constraints that name it come next.

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'CANCELLED';
