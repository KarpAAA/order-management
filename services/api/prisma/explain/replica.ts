// Roadmap 2.8: a streaming read replica behind the primary.
//  A. the state of replication, as the primary and the replica report it;
//  B. the lag: how long after a commit on the primary the replica has replayed it;
//  C. the same list page on the primary and on the replica, in the tenant frame of 2.4;
//  D. read-your-writes with a replica that is 5 s behind: the check the application runs
//     before a GET, from the commit until the replica has caught up, and what the check costs.
// Nothing is written to a table: a commit is made with pg_logical_emit_message, a WAL record
// that carries no row. D sets `recovery_min_apply_delay` on the replica and resets it.
// Needs the datagen data and `pnpm infra:up`.
// Run: pnpm db:explain:replica   (docs/perf/2.8-read-replica.md)
import { Client } from 'pg';

const ROUNDS = 300;
const APPLY_DELAY = '5s';
const LIST = `SELECT id, status, currency, total_minor FROM orders
  WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 21`;

try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell
}

const urls = {
  owner: process.env.DATABASE_ADMIN_URL,
  // the owner on the replica: the same roles and passwords, it is a copy of the primary
  replicaOwner: process.env.REPLICA_ADMIN_URL ?? 'postgresql://oms:oms@127.0.0.1:5433/oms',
  // the application role past the pooler, on each server
  primary: process.env.DATABASE_DIRECT_URL ?? 'postgresql://oms_app:oms_app@127.0.0.1:5432/oms',
  replica: process.env.REPLICA_DIRECT_URL ?? 'postgresql://oms_app:oms_app@127.0.0.1:5433/oms',
};

const print = (line: string) => process.stdout.write(`${line}\n`);
const ms = (value: number) => `${value.toFixed(2)} ms`;

async function connect(url: string | undefined, name: string): Promise<Client> {
  if (!url) throw new Error(`${name} is not set`);
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

const percentile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;

function summary(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  return `p50 ${ms(percentile(sorted, 0.5))}   p95 ${ms(percentile(sorted, 0.95))}   max ${ms(sorted.at(-1) ?? 0)}`;
}

/** A commit on the primary that touches no table; returns the position right after it. */
async function commitOnPrimary(owner: Client): Promise<string> {
  await owner.query(`SELECT pg_logical_emit_message(true, 'oms-explain', 'x')`);
  const { rows } = await owner.query<{ lsn: string }>(
    'SELECT pg_current_wal_insert_lsn()::text AS lsn',
  );
  return rows[0]?.lsn ?? '';
}

/** The check of ReadYourWrites.replicaIsCurrentFor, as the application role. */
async function replayed(replica: Client, lsn: string): Promise<boolean> {
  const { rows } = await replica.query<{ replayed: boolean }>(
    'SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS replayed',
    [lsn],
  );
  return rows[0]?.replayed === true;
}

/** Milliseconds from now until the replica has replayed `lsn`, and how many checks it took. */
async function untilReplayed(
  replica: Client,
  lsn: string,
): Promise<{ took: number; checks: number }> {
  const started = performance.now();
  let checks = 1;
  while (!(await replayed(replica, lsn))) checks += 1;
  return { took: performance.now() - started, checks };
}

async function state(owner: Client, replicaOwner: Client): Promise<void> {
  print('A. Replication state');
  const { rows } = await owner.query<Record<string, string | null>>(
    `SELECT application_name, state, sync_state, sent_lsn::text, replay_lsn::text,
            coalesce(write_lag::text, '0') AS write_lag, coalesce(replay_lag::text, '0') AS replay_lag
       FROM pg_stat_replication`,
  );
  for (const row of rows) print(`  primary:  ${JSON.stringify(row)}`);
  const standby = await replicaOwner.query<Record<string, string | boolean>>(
    `SELECT pg_is_in_recovery() AS in_recovery, pg_last_wal_replay_lsn()::text AS replayed,
            current_setting('hot_standby_feedback') AS hot_standby_feedback,
            pg_size_pretty(pg_database_size(current_database())) AS size`,
  );
  print(`  replica:  ${JSON.stringify(standby.rows[0])}`);
}

async function lag(owner: Client, replica: Client): Promise<void> {
  print(
    `\nB. From a commit on the primary to its replay on the replica (${String(ROUNDS)} commits)`,
  );
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    samples.push((await untilReplayed(replica, await commitOnPrimary(owner))).took);
  }
  print(`  ${summary(samples)}`);
}

async function framedList(client: Client, workspaceId: string): Promise<number> {
  const started = performance.now();
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
  await client.query(LIST, [workspaceId]);
  await client.query('COMMIT');
  return performance.now() - started;
}

async function sameRead(primary: Client, replica: Client, workspaceId: string): Promise<void> {
  print(
    `\nC. The first page of the biggest tenant's orders, tenant frame, ${String(ROUNDS)} rounds`,
  );
  for (const [name, client] of [
    ['primary', primary],
    ['replica', replica],
  ] as const) {
    const samples: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      samples.push(await framedList(client, workspaceId));
    }
    print(`  ${name}   ${summary(samples)}`);
  }
  const visible = await replica.query<{ rows: number }>('SELECT count(*)::int AS rows FROM orders');
  print(
    `  replica, application role, no tenant set: ${String(visible.rows[0]?.rows)} orders visible`,
  );
}

async function readYourWrites(owner: Client, replicaOwner: Client, replica: Client): Promise<void> {
  print(`\nD. Read-your-writes with recovery_min_apply_delay = ${APPLY_DELAY} on the replica`);
  await replicaOwner.query(`ALTER SYSTEM SET recovery_min_apply_delay = '${APPLY_DELAY}'`);
  await replicaOwner.query('SELECT pg_reload_conf()');
  try {
    const lsn = await commitOnPrimary(owner);
    print(`  commit on the primary at ${lsn}`);
    print(
      `  check right after it: replayed = ${String(await replayed(replica, lsn))} → the writer reads the primary`,
    );
    const { took, checks } = await untilReplayed(replica, lsn);
    print(
      `  replayed after ${(took / 1000).toFixed(2)} s (${String(checks)} checks) → the writer reads the replica again`,
    );

    const costs: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const started = performance.now();
      await replayed(replica, lsn);
      costs.push(performance.now() - started);
    }
    print(`  the check itself, one round trip to the replica: ${summary(costs)}`);
  } finally {
    await replicaOwner.query('ALTER SYSTEM RESET recovery_min_apply_delay');
    await replicaOwner.query('SELECT pg_reload_conf()');
  }
}

async function main(): Promise<void> {
  const owner = await connect(urls.owner, 'DATABASE_ADMIN_URL');
  const replicaOwner = await connect(urls.replicaOwner, 'REPLICA_ADMIN_URL');
  const primary = await connect(urls.primary, 'DATABASE_DIRECT_URL');
  const replica = await connect(urls.replica, 'REPLICA_DIRECT_URL');
  try {
    const big = await owner.query<{ id: string }>(
      'SELECT workspace_id AS id FROM orders GROUP BY 1 ORDER BY count(*) DESC LIMIT 1',
    );
    const workspaceId = big.rows[0]?.id;
    if (!workspaceId) throw new Error('no orders: run pnpm db:datagen first');

    await state(owner, replicaOwner);
    await lag(owner, replica);
    await sameRead(primary, replica, workspaceId);
    await readYourWrites(owner, replicaOwner, replica);
  } finally {
    await Promise.all([owner, replicaOwner, primary, replica].map((client) => client.end()));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
