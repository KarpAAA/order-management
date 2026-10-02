-- Runs once, when the postgres container initializes an empty volume (docker-compose.yml).
-- The login of the application role; its privileges and the Row-Level Security policies come
-- from the migrations (20261001180000_enable_row_level_security). Local password, never reused.
-- A volume created before this file existed: after `pnpm db:migrate`, run
--   docker compose exec postgres psql -U oms -d oms -c "ALTER ROLE oms_app LOGIN PASSWORD 'oms_app'"
CREATE ROLE oms_app LOGIN PASSWORD 'oms_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
