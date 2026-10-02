#!/bin/bash
# Runs once, when the postgres container initializes an empty volume (docker-compose.yml), and
# in the e2e run's Postgres (test/setup/postgres.ts). Lets the read replica connect: a role that
# may stream the WAL, and the pg_hba line for it (the image only allows replication locally).
# Local password, never reused. A volume created before this file existed:
#   docker compose exec postgres psql -U oms -d oms -c "CREATE ROLE replicator REPLICATION LOGIN PASSWORD 'replicator'"
#   docker compose exec postgres bash -c 'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
#   docker compose exec postgres psql -U oms -d oms -c "SELECT pg_reload_conf()"
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE ROLE replicator REPLICATION LOGIN PASSWORD 'replicator'"
echo 'host replication replicator all scram-sha-256' >> "$PGDATA/pg_hba.conf"
