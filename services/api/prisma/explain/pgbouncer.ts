// Roadmap 2.7: PgBouncer in transaction mode between the application role and Postgres.
//  A. what the extra hop costs: one connection, the tenant frame of 2.4, direct and pooled;
//  B. many clients on few server connections: max_client_conn clients through the pooler
//     (this script's console connection is one of them), against direct connections;
//  C. the two limits: one client more than max_client_conn, and the same number of clients
//     on Postgres itself, where max_connections stops them;
//  D. why the tenant setting is transaction-local: a session-level one reaches the next client.
// Needs the datagen data and `pnpm infra:up`. One Node process drives every client, so the
// throughput of B is a floor, not the limit of Postgres.
// Run: pnpm db:explain:pgbouncer   (docs/perf/2.7-pgbouncer.md)
import { Client } from 'pg';

const ROUNDS = 2000;
const CLIENTS = 500;
const LOAD_MS = 10_000;
const SAMPLE_MS = 250;
const LIST = `SELECT id, status, currency, total_minor FROM orders
  WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 21`;

try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell
}

const urls = {
  owner: process.env.DATABASE_ADMIN_URL,
  // the application role past the pooler: DATABASE_URL itself points at PgBouncer
  direct: process.env.DATABASE_DIRECT_URL ?? 'postgresql://oms_app:oms_app@localhost:5432/oms',
  pooled: process.env.PGBOUNCER_URL ?? 'postgresql://oms_app:oms_app@localhost:6432/oms',
  stats: process.env.PGBOUNCER_STATS_URL ?? 'postgresql://stats:stats@localhost:6432/pgbouncer',
};

const print = (line: string) => process.stdout.write(`${line}\n`);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function connect(url: string | undefined, name: string): Promise<Client> {
  if (!url) throw new Error(`${name} is not set`);
  const client = new Client({ connectionString: url });
  // a connection the server closes (part C, the end of D) must not crash the process
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/** Opens `count` connections, 50 at a time; the ones the server refused come back as errors. */
async function connectMany(
  url: string | undefined,
  name: string,
  count: number,
): Promise<{ clients: Client[]; errors: string[] }> {
  const clients: Client[] = [];
  const errors: string[] = [];
  for (let opened = 0; opened < count; opened += 50) {
    const batch = await Promise.allSettled(
      Array.from({ length: Math.min(50, count - opened) }, () => connect(url, name)),
    );
    for (const result of batch) {
      if (result.status === 'fulfilled') clients.push(result.value);
      else errors.push(message(result.reason));
    }
  }
  return { clients, errors };
}

/** The tenant frame of 2.4: what the application sends for one list page. */
async function framedList(client: Client, workspaceId: string): Promise<number> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
  const page = await client.query(LIST, [workspaceId]);
  await client.query('COMMIT');
  return page.rowCount ?? 0;
}

const percentile = (sorted: number[], q: number) =>
  (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0).toFixed(2);

/** Median and 95th percentile of `work`, in milliseconds. */
async function measure(work: () => Promise<number>): Promise<string> {
  const times: number[] = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const start = performance.now();
    const rows = await work();
    times.push(performance.now() - start);
    if (rows !== 21) throw new Error(`expected a page of 21 rows, got ${String(rows)}`);
  }
  times.sort((a, b) => a - b);
  return `p50 ${percentile(times, 0.5)}  p95 ${percentile(times, 0.95)}`;
}

interface Peak {
  clActive: number;
  clWaiting: number;
  svActive: number;
  /** Postgres processes of the application role, and those of them inside a transaction. */
  open: number;
  busy: number;
}

/** Samples the PgBouncer console and pg_stat_activity until stopped; returns the peaks. */
function watchPeaks(owner: Client, stats: Client): () => Peak {
  const peak: Peak = { clActive: 0, clWaiting: 0, svActive: 0, open: 0, busy: 0 };
  const sample = async () => {
    const pools = await stats.query<Record<string, string>>('SHOW POOLS');
    const pool = pools.rows.find((row) => row.database === 'oms' && row.user === 'oms_app');
    const activity = await owner.query<{ open: number; busy: number }>(
      `SELECT count(*)::int AS open, (count(*) FILTER (WHERE state <> 'idle'))::int AS busy
       FROM pg_stat_activity WHERE usename = 'oms_app'`,
    );
    peak.clActive = Math.max(peak.clActive, Number(pool?.cl_active ?? 0));
    peak.clWaiting = Math.max(peak.clWaiting, Number(pool?.cl_waiting ?? 0));
    peak.svActive = Math.max(peak.svActive, Number(pool?.sv_active ?? 0));
    peak.open = Math.max(peak.open, activity.rows[0]?.open ?? 0);
    peak.busy = Math.max(peak.busy, activity.rows[0]?.busy ?? 0);
  };
  const timer = setInterval(() => void sample().catch(() => undefined), SAMPLE_MS);
  return () => {
    clearInterval(timer);
    return peak;
  };
}

/**
 * `clients` connections run the framed list for LOAD_MS; the peaks sampled meanwhile are what
 * the load needed from PgBouncer and from Postgres.
 */
async function load(
  label: string,
  clients: Client[],
  workspaceId: string,
  stopWatching: () => Peak,
): Promise<void> {
  const times: number[] = [];
  let failed = 0;
  const deadline = performance.now() + LOAD_MS;

  await Promise.all(
    clients.map(async (client) => {
      while (performance.now() < deadline) {
        const start = performance.now();
        try {
          await framedList(client, workspaceId);
          times.push(performance.now() - start);
        } catch {
          failed += 1;
          return;
        }
      }
    }),
  );
  const peak = stopWatching();

  times.sort((a, b) => a - b);
  print(
    `  ${label.padEnd(30)} ${String(Math.round(times.length / (LOAD_MS / 1000))).padStart(6)} tx/s` +
      `  p50 ${percentile(times, 0.5).padStart(7)}  p95 ${percentile(times, 0.95).padStart(7)}` +
      `  p99 ${percentile(times, 0.99).padStart(7)} ms` +
      `  | backends open ${String(peak.open).padStart(3)} busy ${String(peak.busy).padStart(3)}` +
      `  cl_active ${String(peak.clActive).padStart(3)}  cl_waiting ${String(peak.clWaiting).padStart(3)}` +
      `  sv_active ${String(peak.svActive).padStart(2)}  failed ${String(failed)}`,
  );
}

const end = (clients: Client[]) => Promise.all(clients.map((client) => client.end()));

async function hop(workspaceId: string): Promise<void> {
  const direct = await connect(urls.direct, 'DATABASE_DIRECT_URL');
  const pooled = await connect(urls.pooled, 'PGBOUNCER_URL');
  try {
    print(`A. one connection, ${String(ROUNDS)} rounds of BEGIN + set_config + list + COMMIT, ms`);
    print(`  direct to Postgres       ${await measure(() => framedList(direct, workspaceId))}`);
    print(`  through PgBouncer        ${await measure(() => framedList(pooled, workspaceId))}`);
  } finally {
    await end([direct, pooled]);
  }
}

async function manyClients(workspaceId: string, owner: Client, stats: Client): Promise<void> {
  print(
    `\nB. ${String(LOAD_MS / 1000)} s of the same transaction from every client (peaks sampled)`,
  );
  // the console connection of this script is a client of PgBouncer too
  for (const [target, url, name, count] of [
    ['through PgBouncer', urls.pooled, 'PGBOUNCER_URL', CLIENTS - 1],
    ['direct', urls.direct, 'DATABASE_DIRECT_URL', 20],
    // as many as Postgres still takes beside the server connections PgBouncer keeps open
    ['direct', urls.direct, 'DATABASE_DIRECT_URL', 90],
  ] as const) {
    const { clients } = await connectMany(url, name, count);
    const label = `${String(clients.length)} clients ${target}`;
    await load(label, clients, workspaceId, watchPeaks(owner, stats));
    await end(clients);
  }
}

const outcome = (result: { clients: Client[]; errors: string[] }) =>
  `connected ${String(result.clients.length)}, refused ${String(result.errors.length)}: ${result.errors[0] ?? '-'}`;

async function limits(owner: Client): Promise<void> {
  print(`\nC. ${String(CLIENTS)} clients and the two limits`);

  const pooled = await connectMany(urls.pooled, 'PGBOUNCER_URL', CLIENTS);
  print(`  through PgBouncer, the console being one more client: ${outcome(pooled)}`);
  await end(pooled.clients);

  const limit = await owner.query<{ max: string }>(
    `SELECT current_setting('max_connections') AS max`,
  );
  const direct = await connectMany(urls.direct, 'DATABASE_DIRECT_URL', CLIENTS);
  print(`  direct, max_connections ${limit.rows[0]?.max ?? '?'}: ${outcome(direct)}`);
  await end(direct.clients);
}

async function leak(workspaceId: string, owner: Client): Promise<void> {
  const first = await connect(urls.pooled, 'PGBOUNCER_URL');
  const second = await connect(urls.pooled, 'PGBOUNCER_URL');
  const seenBySecond = async () =>
    (
      await second.query<{ pid: number; orders: number }>(
        'SELECT pg_backend_pid() AS pid, count(*)::int AS orders FROM orders',
      )
    ).rows[0];
  try {
    print('\nD. two clients of PgBouncer; the first sets the tenant, the second sets nothing');

    await first.query('BEGIN');
    const local = await first.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS pid, set_config('app.workspace_id', $1, true)`,
      [workspaceId],
    );
    await first.query('COMMIT');
    const afterLocal = await seenBySecond();
    print(
      `  set_config(…, true) in a transaction   backend ${String(local.rows[0]?.pid)}` +
        ` → second client on backend ${String(afterLocal?.pid)} counts ${String(afterLocal?.orders)} orders`,
    );

    const session = await first.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS pid, set_config('app.workspace_id', $1, false)`,
      [workspaceId],
    );
    const afterSession = await seenBySecond();
    print(
      `  set_config(…, false), session-level    backend ${String(session.rows[0]?.pid)}` +
        ` → second client on backend ${String(afterSession?.pid)} counts ${String(afterSession?.orders)} orders`,
    );
    // the tenant stays on that server connection for whoever gets it next: close the backend
    await owner.query('SELECT pg_terminate_backend($1)', [session.rows[0]?.pid]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterClose = await seenBySecond();
    print(
      `  that backend closed by the owner       ` +
        `→ second client on backend ${String(afterClose?.pid)} counts ${String(afterClose?.orders)} orders`,
    );
  } finally {
    await end([first, second]);
  }
}

async function main(): Promise<void> {
  const owner = await connect(urls.owner, 'DATABASE_ADMIN_URL');
  const stats = await connect(urls.stats, 'PGBOUNCER_STATS_URL');
  try {
    const big = await owner.query<{ id: string }>(
      'SELECT workspace_id AS id FROM orders GROUP BY 1 ORDER BY count(*) DESC LIMIT 1',
    );
    const workspaceId = big.rows[0]?.id;
    if (!workspaceId) throw new Error('no orders: run pnpm db:datagen first');

    await hop(workspaceId);
    await manyClients(workspaceId, owner, stats);
    await limits(owner);
    await leak(workspaceId, owner);
  } finally {
    await end([owner, stats]);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
