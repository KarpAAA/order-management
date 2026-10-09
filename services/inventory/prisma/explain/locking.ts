// Roadmap 3.6: many orders want the same stock at once. Who gets it, and why.
//  A. the last unit: 50 buyers, 1 unit, under four ways of writing "reserve one":
//       naive        read, check in the code, write what was read + 1
//       conditional  one UPDATE that checks and writes
//       for update   lock the row, read, check in the code, write   (what the service does)
//       version      read, write only if nobody wrote since, retry otherwise
//  B. the same with 25 units: half of the buyers win, so the losers of a round have a
//     reason to try again;
//  C. two rows, two orders: locked in the order each order names them, and in one order
//     for everybody.
// Runs on a table of its own, created and dropped here; the tables of the service are not
// touched. Needs `pnpm infra:up`.
// Run: pnpm db:explain:stock   (docs/perf/3.6-stock-locking.md)
import { Pool } from 'pg';

import type { PoolClient } from 'pg';

const BUYERS = 50;
const PAIRS = 10;
const DEADLOCK = '40P01';

try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell
}
const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL is not set');

// one connection per buyer: they must be able to hold a transaction each at the same time;
// one more for the script itself, which reads the row while the buyers still hold theirs
const pool = new Pool({ connectionString: databaseUrl, max: BUYERS + 1 });

const print = (line: string) => process.stdout.write(`${line}\n`);

interface Outcome {
  /** The buyer was told it holds a unit. */
  won: boolean;
  statements: number;
  retries: number;
}

interface Row {
  on_hand: number;
  reserved: number;
  version: number;
}

type Strategy = (client: PoolClient) => Promise<Outcome>;

const READ = 'SELECT on_hand, reserved, version FROM stock_locking_demo WHERE id = 1';

/** Read, decide in the code, write the number that was read plus one. */
const naive: Strategy = async (client) => {
  await client.query('BEGIN');
  const { rows } = await client.query<Row>(READ);
  const row = rows[0];
  const won = row !== undefined && row.on_hand - row.reserved >= 1;
  if (won) {
    await client.query('UPDATE stock_locking_demo SET reserved = $1 WHERE id = 1', [
      row.reserved + 1,
    ]);
  }
  await client.query('COMMIT');
  return { won, statements: won ? 4 : 3, retries: 0 };
};

/** The check and the write are one statement: the row is locked while both happen. */
const conditional: Strategy = async (client) => {
  const { rowCount } = await client.query(
    'UPDATE stock_locking_demo SET reserved = reserved + 1 WHERE id = 1 AND on_hand - reserved >= 1',
  );
  return { won: rowCount === 1, statements: 1, retries: 0 };
};

/** Lock first: the second buyer waits here and then reads what the first one left. */
const forUpdate: Strategy = async (client) => {
  await client.query('BEGIN');
  const { rows } = await client.query<Row>(`${READ} FOR UPDATE`);
  const row = rows[0];
  const won = row !== undefined && row.on_hand - row.reserved >= 1;
  if (won) {
    await client.query('UPDATE stock_locking_demo SET reserved = $1 WHERE id = 1', [
      row.reserved + 1,
    ]);
  }
  await client.query('COMMIT');
  return { won, statements: won ? 4 : 3, retries: 0 };
};

/** Nobody waits: whoever finds the version changed reads again and decides again. */
const version: Strategy = async (client) => {
  let statements = 0;
  for (let retries = 0; ; retries++) {
    const { rows } = await client.query<Row>(READ);
    statements++;
    const row = rows[0];
    if (row === undefined || row.on_hand - row.reserved < 1) {
      return { won: false, statements, retries };
    }
    const { rowCount } = await client.query(
      `UPDATE stock_locking_demo SET reserved = $1, version = version + 1
        WHERE id = 1 AND version = $2`,
      [row.reserved + 1, row.version],
    );
    statements++;
    if (rowCount === 1) return { won: true, statements, retries };
  }
};

const STRATEGIES: [string, Strategy][] = [
  ['naive', naive],
  ['conditional', conditional],
  ['for update', forUpdate],
  ['version', version],
];

async function race(units: number, strategy: Strategy) {
  await pool.query('UPDATE stock_locking_demo SET on_hand = $1, reserved = 0, version = 0', [
    units,
  ]);
  const clients = await Promise.all(Array.from({ length: BUYERS }, () => pool.connect()));
  const started = performance.now();
  try {
    const outcomes = await Promise.all(clients.map((client) => strategy(client)));
    const elapsed = performance.now() - started;
    const { rows } = await pool.query<Row>(READ);
    return {
      told: outcomes.filter((outcome) => outcome.won).length,
      held: rows[0]?.reserved ?? 0,
      statements: outcomes.reduce((sum, outcome) => sum + outcome.statements, 0),
      retries: outcomes.reduce((sum, outcome) => sum + outcome.retries, 0),
      elapsed,
    };
  } finally {
    for (const client of clients) client.release();
  }
}

async function scenario(title: string, units: number): Promise<void> {
  print(`\n${title}`);
  print('strategy      told "yours"   held in the row   statements   retries   time');
  for (const [name, strategy] of STRATEGIES) {
    const r = await race(units, strategy);
    const verdict = r.told === units && r.held === units ? '' : '   <- wrong';
    print(
      `${name.padEnd(12)}  ${String(r.told).padStart(12)}   ${String(r.held).padStart(15)}   ${String(r.statements).padStart(10)}   ${String(r.retries).padStart(7)}   ${r.elapsed.toFixed(0).padStart(4)} ms${verdict}`,
    );
  }
}

/** One order: two rows locked one after the other, with a pause that lets the other order in. */
async function lockTwo(first: number, second: number): Promise<'done' | 'deadlock'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM stock_locking_demo WHERE id = $1 FOR UPDATE', [first]);
    await client.query('SELECT pg_sleep(0.05)');
    await client.query('SELECT 1 FROM stock_locking_demo WHERE id = $1 FOR UPDATE', [second]);
    await client.query('COMMIT');
    return 'done';
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    if ((err as { code?: string }).code === DEADLOCK) return 'deadlock';
    throw err;
  } finally {
    client.release();
  }
}

async function lockOrder(title: string, sorted: boolean): Promise<void> {
  const started = performance.now();
  // each pair: one order names the rows 1, 2 and the other 2, 1
  const outcomes = await Promise.all(
    Array.from({ length: PAIRS * 2 }, (_, i) => {
      const [first, second] = i % 2 === 0 || sorted ? [1, 2] : [2, 1];
      return lockTwo(first, second);
    }),
  );
  const deadlocks = outcomes.filter((outcome) => outcome === 'deadlock').length;
  const elapsed = (performance.now() - started).toFixed(0);
  print(
    `${title.padEnd(28)}  ${String(outcomes.length - deadlocks).padStart(4)} done   ${String(deadlocks).padStart(3)} broken by the database   ${elapsed.padStart(5)} ms`,
  );
}

async function main(): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS stock_locking_demo');
  await pool.query(`CREATE TABLE stock_locking_demo (
    id integer PRIMARY KEY,
    on_hand integer NOT NULL,
    reserved integer NOT NULL DEFAULT 0,
    version integer NOT NULL DEFAULT 0
  )`);
  await pool.query('INSERT INTO stock_locking_demo (id, on_hand) VALUES (1, 0), (2, 0)');
  try {
    await scenario(`A. ${String(BUYERS)} buyers, 1 unit`, 1);
    await scenario(`B. ${String(BUYERS)} buyers, 25 units`, 25);
    print(`\nC. ${String(PAIRS * 2)} orders, each locks two rows`);
    await lockOrder('in the order each names them', false);
    await lockOrder('in one order for everybody', true);
  } finally {
    await pool.query('DROP TABLE stock_locking_demo');
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
