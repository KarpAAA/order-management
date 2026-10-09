-- Runs once, when the postgres-notifications container initializes an empty volume (docker-compose.yml).
-- The login of the application role; its privileges come from the migrations of
-- services/notifications (20261009140000_init). Local password, never reused.
CREATE ROLE notifications_app LOGIN PASSWORD 'notifications_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
