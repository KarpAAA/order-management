-- Runs once, when the postgres-inventory container initializes an empty volume (docker-compose.yml).
-- The login of the application role; its privileges come from the migrations of
-- services/inventory (20261009100000_init). Local password, never reused.
CREATE ROLE inventory_app LOGIN PASSWORD 'inventory_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
