-- The correlation id of the event a notification was asked by (docs/adr/0023). The mail goes
-- out later, from a timer that has no chain of its own: the dispatcher logs under this id.
-- Nullable: the rows that are there were written without one, and get a chain of their own.
-- No new grant: `notifications_app` holds SELECT, INSERT, UPDATE and DELETE on the table.
ALTER TABLE "notifications" ADD COLUMN "correlation_id" UUID;
