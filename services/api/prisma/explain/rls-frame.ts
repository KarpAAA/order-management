// Roadmap 2.4: what the transaction frame around a tenant query costs from the client side.
// The first page of the orders list of the biggest tenant, as the application role: alone
// (as before Row-Level Security) and inside BEGIN + set_config + COMMIT (as the tenant choke
// point sends it now). One connection, so the numbers are round trips, not pool waits.
// Run: pnpm --filter @oms/api exec tsx prisma/explain/rls-frame.ts   (docs/perf/2.4-rls.md)
import { Client } from 'pg';

const ROUNDS = 2000;
const LIST = `SELECT id, status, currency, total_minor FROM orders
  WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 21`;

try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell
}

async function connect(url: string | undefined, name: string): Promise<Client> {
  if (!url) throw new Error(`${name} is not set`);
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Median and 95th percentile of `work`, in milliseconds. */
async function measure(work: () => Promise<number>): Promise<{ p50: string; p95: string }> {
  const times: number[] = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const start = performance.now();
    const rows = await work();
    times.push(performance.now() - start);
    if (rows !== 21) throw new Error(`expected a page of 21 rows, got ${String(rows)}`);
  }
  times.sort((a, b) => a - b);
  const at = (q: number) => (times[Math.floor(ROUNDS * q)] ?? 0).toFixed(3);
  return { p50: at(0.5), p95: at(0.95) };
}

async function main(): Promise<void> {
  const owner = await connect(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL');
  const app = await connect(process.env.DATABASE_URL, 'DATABASE_URL');
  try {
    const big = await owner.query<{ id: string }>(
      'SELECT workspace_id AS id FROM orders GROUP BY 1 ORDER BY count(*) DESC LIMIT 1',
    );
    const workspaceId = big.rows[0]?.id;
    if (!workspaceId) throw new Error('no orders: run pnpm db:datagen first');

    const bare = await measure(async () => (await owner.query(LIST, [workspaceId])).rowCount ?? 0);
    const framed = await measure(async () => {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const page = await app.query(LIST, [workspaceId]);
      await app.query('COMMIT');
      return page.rowCount ?? 0;
    });

    process.stdout.write(
      `${String(ROUNDS)} rounds, ms\n` +
        `  query alone (owner, no policy)        p50 ${bare.p50}  p95 ${bare.p95}\n` +
        `  BEGIN + set_config + query + COMMIT   p50 ${framed.p50}  p95 ${framed.p95}\n`,
    );
  } finally {
    await owner.end();
    await app.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
