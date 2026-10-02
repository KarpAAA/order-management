import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedNetwork } from 'testcontainers';

/** The name Postgres has on the run's Docker network: PgBouncer and the replica reach it by this name. */
export const POSTGRES_ALIAS = 'postgres';

/** The init script of the dev stack: the replication role and its pg_hba line. */
const REPLICATION_INIT = resolve(__dirname, '../../../../devtools/postgres/init/02-replication.sh');

/**
 * Throwaway Postgres for one run: random port, never the dev container. On `network` it is
 * also reachable by its alias, for a container in front of it or a replica behind it.
 */
export function startPostgres(network?: StartedNetwork): Promise<StartedPostgreSqlContainer> {
  const container = new PostgreSqlContainer('postgres:18');
  if (network) container.withNetwork(network).withNetworkAliases(POSTGRES_ALIAS);
  return (
    container
      .withCopyFilesToContainer([
        { source: REPLICATION_INIT, target: '/docker-entrypoint-initdb.d/02-replication.sh' },
      ])
      // durability off: the database lives for one run, writes get much cheaper. Never in prod.
      .withCommand([
        'postgres',
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
        '-c',
        'full_page_writes=off',
      ])
      .withTmpFs({ '/var/lib/postgresql': 'rw' })
      .start()
  );
}
