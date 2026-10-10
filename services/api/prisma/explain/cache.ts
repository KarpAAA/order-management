// Roadmap 2.9: the catalog cache in Redis, with the RedisCache the application runs.
//  A. latency: a product and the first list page from the database (tenant frame of 2.4,
//     through PgBouncer, plus the workspace terms) and from the cache;
//  B. hit ratio: reads skewed towards a few products, with a catalog change every N reads
//     (a change invalidates the whole workspace);
//  C. cache stampede: 200 callers on an empty key from 4 processes, with no protection, with
//     single-flight and with the lock: how many reach the database;
//  D. TTL jitter: when 1000 keys stored in the same second expire.
// Keys live under their own prefix and are deleted at the end; no table is written.
// Needs the datagen data and `pnpm infra:up`.
// Run: pnpm db:explain:cache   (docs/perf/2.9-cache.md)
import { Client, Pool } from 'pg';

import { RedisCache, type StampedeProtection } from '../../src/infrastructure/cache/redis-cache';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { silentLogger } from '../../src/shared/logger/silent-logger';

import type { ReadSource } from '../../src/infrastructure/database/read-source';

const PREFIX = 'explain-cache';
const ROUNDS = 1000;
const READS = 10_000;
const PROCESSES = 4;
const CALLERS = 200;
const TTL_SECONDS = 300;

const PRODUCT = `SELECT id, sku, name, description, price_minor, status, created_at, updated_at
  FROM products WHERE id = $1 LIMIT 1`;
const LIST = `SELECT id, sku, name, description, price_minor, status, created_at, updated_at
  FROM products ORDER BY created_at DESC, id DESC LIMIT 21`;
const TERMS = 'SELECT currency, tax_rate_bps FROM workspaces WHERE id = $1';

try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell
}

const print = (line: string) => process.stdout.write(`${line}\n`);
const ms = (value: number) => `${value.toFixed(2)} ms`;
const percent = (part: number, whole: number) => `${((100 * part) / whole).toFixed(1)} %`;

const percentile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;

function summary(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  return `p50 ${ms(percentile(sorted, 0.5))}   p95 ${ms(percentile(sorted, 0.95))}   max ${ms(sorted.at(-1) ?? 0)}`;
}

async function timed(rounds: number, work: () => Promise<unknown>): Promise<number[]> {
  const samples: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    await work();
    samples.push(performance.now() - started);
  }
  return samples;
}

interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** What CatalogQueryService sends for one read: the tenant frame around the query, and the terms. */
async function fromDatabase(
  db: Queryable,
  workspaceId: string,
  sql: string,
  values: unknown[] = [],
): Promise<unknown> {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
  const { rows } = await db.query(sql, values);
  await db.query('COMMIT');
  const terms = await db.query(TERMS, [workspaceId]);
  return { rows, terms: terms.rows[0] };
}

// the script has no request and no replica to leave
const source = { requirePrimary: () => undefined } as unknown as ReadSource;

const newCache = (redis: RedisService): RedisCache =>
  new RedisCache(redis, source, { prefix: PREFIX, catalogTtlSeconds: TTL_SECONDS }, silentLogger);

async function latency(
  app: Client,
  cache: RedisCache,
  workspaceId: string,
  productId: string,
): Promise<void> {
  print(
    `A. One read, ${String(ROUNDS)} rounds (database: through PgBouncer, tenant frame + terms)`,
  );
  const namespace = `catalog:${workspaceId}`;
  for (const [name, key, sql, values] of [
    ['product', `product:${productId}`, PRODUCT, [productId]],
    ['list   ', 'list:all:20:first', LIST, []],
  ] as const) {
    const load = () => fromDatabase(app, workspaceId, sql, [...values]);
    print(`  ${name}  database  ${summary(await timed(ROUNDS, load))}`);
    await cache.getOrLoad({ namespace, key, ttlSeconds: TTL_SECONDS, load });
    const hit = () => cache.getOrLoad({ namespace, key, ttlSeconds: TTL_SECONDS, load });
    print(`  ${name}  cache hit ${summary(await timed(ROUNDS, hit))}`);
  }
}

/** Ranks 0…n-1 drawn with probability ∝ 1/(rank+1): a few products take most of the reads. */
function zipf(n: number): () => number {
  const cumulative: number[] = [];
  let total = 0;
  for (let rank = 0; rank < n; rank += 1) {
    total += 1 / (rank + 1);
    cumulative.push(total);
  }
  return () => {
    const target = Math.random() * total;
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((cumulative[middle] ?? 0) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

async function hitRatio(
  app: Client,
  redis: RedisService,
  workspaceId: string,
  productIds: string[],
): Promise<void> {
  print(
    `\nB. Hit ratio: ${String(READS)} product reads over ${String(productIds.length)} products, skewed (Zipf)`,
  );
  const next = zipf(productIds.length);
  for (const writeEvery of [0, 2000, 500, 100]) {
    const cache = newCache(redis);
    const namespace = `catalog:ratio-${String(writeEvery)}:${workspaceId}`;
    const samples: number[] = [];
    for (let read = 1; read <= READS; read += 1) {
      const productId = productIds[next()] ?? '';
      const started = performance.now();
      await cache.getOrLoad({
        namespace,
        key: `product:${productId}`,
        ttlSeconds: TTL_SECONDS,
        load: () => fromDatabase(app, workspaceId, PRODUCT, [productId]),
      });
      samples.push(performance.now() - started);
      if (writeEvery > 0 && read % writeEvery === 0) await cache.invalidate(namespace);
    }
    const { hits, loads } = cache.stats();
    const writes =
      writeEvery === 0 ? 'no change      ' : `a change / ${String(writeEvery).padEnd(4)} `;
    print(
      `  ${writes}  hit ratio ${percent(hits, READS).padStart(6)}   database reads ${String(loads).padStart(5)}   ${summary(samples)}`,
    );
  }
}

async function stampede(
  pool: Pool,
  connections: RedisService[],
  workspaceId: string,
  productId: string,
): Promise<void> {
  print(
    `\nC. ${String(CALLERS)} callers on an empty key, from ${String(PROCESSES)} processes (20 server connections behind PgBouncer)`,
  );
  for (const protection of ['none', 'single-flight', 'lock'] satisfies StampedeProtection[]) {
    const caches = connections.map(newCache);
    const [first] = caches;
    if (!first) throw new Error('no Redis connection');
    const load = async () => {
      const client = await pool.connect();
      try {
        return await fromDatabase(client, workspaceId, PRODUCT, [productId]);
      } finally {
        client.release();
      }
    };
    const started = performance.now();
    await Promise.all(
      Array.from({ length: CALLERS }, (_, caller) =>
        (caches[caller % PROCESSES] ?? first).getOrLoad({
          namespace: `catalog:stampede-${protection}:${workspaceId}`,
          key: `product:${productId}`,
          ttlSeconds: TTL_SECONDS,
          load,
          protection,
        }),
      ),
    );
    const took = performance.now() - started;
    const loads = caches.reduce((sum, cache) => sum + cache.stats().loads, 0);
    print(
      `  ${protection.padEnd(14)} database reads ${String(loads).padStart(3)}   all answered in ${ms(took)}`,
    );
  }
}

async function jitter(redis: RedisService): Promise<void> {
  const KEYS = 1000;
  print(`\nD. ${String(KEYS)} keys stored in the same second, TTL ${String(TTL_SECONDS)} s ±10 %`);
  const cache = newCache(redis);
  await Promise.all(
    Array.from({ length: KEYS }, (_, key) =>
      cache.getOrLoad({
        namespace: 'jitter',
        key: String(key),
        ttlSeconds: TTL_SECONDS,
        load: () => Promise.resolve(key),
        protection: 'none',
      }),
    ),
  );
  const pipeline = redis.pipeline();
  for (let key = 0; key < KEYS; key += 1) pipeline.ttl(`${PREFIX}:jitter:v0:${String(key)}`);
  const ttls = ((await pipeline.exec()) ?? []).map(([, ttl]) => Number(ttl));
  const perSecond = new Map<number, number>();
  for (const ttl of ttls) perSecond.set(ttl, (perSecond.get(ttl) ?? 0) + 1);
  print(
    `  they expire between ${String(Math.min(...ttls))} s and ${String(Math.max(...ttls))} s from now; ` +
      `the busiest second takes ${String(Math.max(...perSecond.values()))} of them (without jitter: ${String(KEYS)})`,
  );
}

async function redisCounters(redis: RedisService): Promise<{ hits: number; misses: number }> {
  const info = await redis.info('stats');
  const read = (name: string) => Number(new RegExp(`${name}:(\\d+)`).exec(info)?.[1] ?? 0);
  return { hits: read('keyspace_hits'), misses: read('keyspace_misses') };
}

async function cleanUp(redis: RedisService): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}:*`, 'COUNT', 1000);
    cursor = next;
    if (keys.length > 0) deleted += await redis.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!redisUrl || !appUrl) throw new Error('REDIS_URL and DATABASE_URL must be set');
  const connections = Array.from(
    { length: PROCESSES },
    () => new RedisService({ url: redisUrl, queuePrefix: 'unused' }),
  );
  const redis = connections[0];
  if (!redis) throw new Error('no Redis connection');
  const owner = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  const app = new Client({ connectionString: appUrl });
  // every caller of C may hold a client connection, as 200 requests of the api would
  const pool = new Pool({ connectionString: appUrl, max: CALLERS });
  await Promise.all([owner.connect(), app.connect()]);
  try {
    const big = await owner.query<{ id: string }>(
      'SELECT workspace_id AS id FROM products GROUP BY 1 ORDER BY count(*) DESC LIMIT 1',
    );
    const workspaceId = big.rows[0]?.id;
    if (!workspaceId) throw new Error('no products: run pnpm db:datagen first');
    const products = await owner.query<{ id: string }>(
      'SELECT id FROM products WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC',
      [workspaceId],
    );
    const productIds = products.rows.map((row) => row.id);
    const productId = productIds[0] ?? '';

    await cleanUp(redis);
    const before = await redisCounters(redis);
    await latency(app, newCache(redis), workspaceId, productId);
    await hitRatio(app, redis, workspaceId, productIds);
    await stampede(pool, connections, workspaceId, productId);
    await jitter(redis);
    const after = await redisCounters(redis);
    print(
      `\nRedis INFO stats over the run: keyspace_hits +${String(after.hits - before.hits)}, ` +
        `keyspace_misses +${String(after.misses - before.misses)} ` +
        '(a cache hit is two GETs: the version of the namespace, then the value)',
    );
    print(`Deleted ${String(await cleanUp(redis))} keys of this run.`);
  } finally {
    await Promise.all([owner.end(), app.end(), pool.end()]);
    for (const connection of connections) connection.disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
