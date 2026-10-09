-- Runs once, when the postgres-payments container initializes an empty volume (docker-compose.yml).
-- The login of the application role; its privileges come from the migrations of
-- services/payments (20261006160000_init). Local password, never reused.
-- A volume created before this file existed: after `pnpm db:migrate:payments`, run
--   docker compose exec postgres-payments psql -U payments -d payments -c "ALTER ROLE payments_app LOGIN PASSWORD 'payments_app'"
CREATE ROLE payments_app LOGIN PASSWORD 'payments_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
