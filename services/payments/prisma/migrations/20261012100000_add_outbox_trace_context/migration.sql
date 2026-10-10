-- The trace a message was written in (docs/adr/0025-traces-opentelemetry.md): the relay
-- publishes the row later, from a timer, where the context of the request is gone. The row
-- keeps the W3C `traceparent`, and the relay publishes in it. NULL: written outside a trace,
-- or before the column was there. Nullable with no default: no rewrite of the table, and the
-- application role has its rights on the table already.

-- AlterTable
ALTER TABLE "outbox" ADD COLUMN     "trace_context" JSONB;
