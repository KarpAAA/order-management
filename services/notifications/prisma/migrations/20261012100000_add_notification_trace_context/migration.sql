-- The trace of the event that asked for a notification (docs/adr/0025-traces-opentelemetry.md):
-- the mail is sent later, by the dispatcher, and its span belongs to that trace. NULL: written
-- outside a trace, or before the column was there.

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "trace_context" JSONB;
