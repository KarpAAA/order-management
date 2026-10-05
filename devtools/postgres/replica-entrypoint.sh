#!/bin/bash
# Entrypoint of the read replica (docker-compose.yml, test/setup/replica.ts;
# docs/adr/0009-read-replica-routing.md). On an empty volume it copies the primary with
# pg_basebackup; --write-recovery-conf leaves standby.signal and primary_conninfo behind, so
# the server then starts as a hot standby that streams the WAL. Later starts skip the copy.
#
# No replication slot on purpose: a slot makes the primary keep WAL for a replica that is
# stopped, without limit. The price: a replica that was down for too long cannot catch up and
# is rebuilt by removing its volume.
set -euo pipefail

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  install -d -o postgres -g postgres -m 0700 "$PGDATA"
  until pg_isready --host="$PRIMARY_HOST" --quiet; do sleep 1; done
  PGPASSWORD="$REPLICATION_PASSWORD" gosu postgres pg_basebackup \
    --host="$PRIMARY_HOST" --username=replicator --pgdata="$PGDATA" \
    --write-recovery-conf --wal-method=stream --checkpoint=fast
fi

exec docker-entrypoint.sh postgres "$@"
