import { GenericContainer } from 'testcontainers';

import { APP_ROLE } from './database-url';
import { POSTGRES_ALIAS } from './postgres';

import type { StartedNetwork, StartedTestContainer } from 'testcontainers';

/** The image of the `pgbouncer` service in docker-compose.yml. */
const IMAGE = 'edoburu/pgbouncer:v1.25.2-p0';
const PORT = 6432;

/**
 * A PgBouncer database with ONE server connection, on the maintenance database of Postgres:
 * two clients of it take turns on the same backend, which is what a leak test needs.
 */
export const ONE_CONNECTION_DB = 'one_connection';

// `*`: every test file has a database of its own (db.ts), forwarded under its own name.
// Five server connections per database, fewer than the application's pool: clients queue.
const CONFIG = `[databases]
${ONE_CONNECTION_DB} = host=${POSTGRES_ALIAS} port=5432 dbname=postgres pool_size=1
* = host=${POSTGRES_ALIAS} port=5432

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${String(PORT)}
unix_socket_dir =
pool_mode = transaction
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
default_pool_size = 5
`;

/** PgBouncer in transaction mode in front of the run's Postgres, for the application role. */
export function startPgBouncer(network: StartedNetwork): Promise<StartedTestContainer> {
  return new GenericContainer(IMAGE)
    .withNetwork(network)
    .withCopyContentToContainer([
      { content: CONFIG, target: '/etc/pgbouncer/pgbouncer.ini' },
      { content: `"${APP_ROLE}" "${APP_ROLE}"\n`, target: '/etc/pgbouncer/userlist.txt' },
    ])
    .withExposedPorts(PORT)
    .start();
}

/** PgBouncer as the application role, on the maintenance database: swap the name per use. */
export function pgBouncerUrl(container: StartedTestContainer): string {
  const host = `${container.getHost()}:${String(container.getMappedPort(PORT))}`;
  return `postgres://${APP_ROLE}:${APP_ROLE}@${host}/postgres`;
}
