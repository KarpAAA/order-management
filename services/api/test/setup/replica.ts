import { resolve } from 'node:path';

import { Client } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';

import { POSTGRES_ALIAS } from './postgres';

import type { StartedNetwork, StartedTestContainer } from 'testcontainers';

const PORT = 5432;

/** The entrypoint of the `postgres-replica` service in docker-compose.yml, the same file. */
const ENTRYPOINT = resolve(__dirname, '../../../../devtools/postgres/replica-entrypoint.sh');

/**
 * A hot standby of the run's Postgres: it copies the primary, then streams its WAL. Physical
 * replication carries every database, so the database of each test file appears here by
 * itself, a moment after it was created on the primary.
 */
export function startReplica(network: StartedNetwork): Promise<StartedTestContainer> {
  return (
    new GenericContainer('postgres:18')
      .withNetwork(network)
      .withCopyFilesToContainer([
        { source: ENTRYPOINT, target: '/usr/local/bin/replica-entrypoint.sh' },
      ])
      .withEntrypoint(['bash', '/usr/local/bin/replica-entrypoint.sh'])
      .withEnvironment({ PRIMARY_HOST: POSTGRES_ALIAS, REPLICATION_PASSWORD: 'replicator' })
      .withTmpFs({ '/var/lib/postgresql': 'rw' })
      .withExposedPorts(PORT)
      .withWaitStrategy(Wait.forLogMessage(/ready to accept read-only connections/))
      // it waits for the primary first, then copies it: on a busy machine a minute was too little
      .withStartupTimeout(180_000)
      .start()
  );
}

/** The replica's maintenance database as the superuser of the primary (`serverUrl`). */
export function replicaUrl(container: StartedTestContainer, serverUrl: string): string {
  const url = new URL(serverUrl);
  url.host = `${container.getHost()}:${String(container.getMappedPort(PORT))}`;
  return url.toString();
}

/**
 * Replication lag on demand, with no sleep: while replay is paused the replica keeps receiving
 * the WAL and applies none of it, so it shows the past for as long as a test needs.
 */
export class ReplicaControl {
  private constructor(private readonly client: Client) {}

  static async connect(url: string): Promise<ReplicaControl> {
    const client = new Client({ connectionString: url });
    await client.connect();
    return new ReplicaControl(client);
  }

  async pause(): Promise<void> {
    await this.client.query('SELECT pg_wal_replay_pause()');
  }

  /** Resumes replay and returns once the replica has applied everything up to `lsn`. */
  async resumeAndCatchUp(lsn: string): Promise<void> {
    await this.client.query('SELECT pg_wal_replay_resume()');
    await this.caughtUp(lsn);
  }

  async caughtUp(lsn: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await this.client.query<{ replayed: boolean }>(
        'SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS replayed',
        [lsn],
      );
      if (rows[0]?.replayed) return;
      if (Date.now() > deadline) throw new Error(`the replica did not replay up to ${lsn}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async close(): Promise<void> {
    await this.client.query('SELECT pg_wal_replay_resume()');
    await this.client.end();
  }
}
