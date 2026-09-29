import { PostgreSqlContainer } from '@testcontainers/postgresql';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/** Throwaway Postgres for one run: random port, never the dev container. */
export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return (
    new PostgreSqlContainer('postgres:18')
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
