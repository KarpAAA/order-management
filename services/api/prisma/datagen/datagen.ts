// Step 2 data generator (docs/ROADMAP.md 2.1): ~100 tenants with a Zipf size distribution,
// ~2M orders with items and history, loaded with COPY, then VACUUM ANALYZE and a size report.
// order_events is partitioned by month: the partitions of the whole window are created first.
// Deterministic: the same --seed and --until give the same data. Run after `pnpm db:reset`.
// Writes directly, outside the app's tenant-scope extension, like prisma/seed.ts.
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import { PrismaClient } from '../../src/infrastructure/database/generated/prisma/client';
import { createPartitionSql } from '../../src/modules/orders/infrastructure/order-event-partitions.sql';
import { addMonths, monthIndex, yearMonthOf } from '../../src/shared/domain/year-month';

import { seedCatalog } from './catalog';
import { copyRows } from './copy';
import { seedPeople } from './identity';
import { parseOptions } from './options';
import { buildOrder } from './orders';
import { planTenants, windowStart } from './plan';
import { Rng } from './random';
import { analyzeAndReport } from './report';

import type { ColumnMap } from './copy';
import type { DatagenOptions } from './options';
import type { TenantContext, OrderRows } from './orders';
import type { TenantPlan } from './plan';
import type { Prisma } from '../../src/infrastructure/database/generated/prisma/client';
import type { PoolClient } from 'pg';

const CHUNK = 5_000;
/** Order timestamps get denser towards `until`: the last day sees GROWTH× the first. */
const GROWTH = 3;

const ORDER_COLUMNS: ColumnMap<Prisma.OrderUncheckedCreateInput> = [
  ['workspace_id', 'workspaceId'],
  ['id', 'id'],
  ['status', 'status'],
  ['currency', 'currency'],
  ['discount_type', 'discountType'],
  ['discount_value_bps', 'discountValueBps'],
  ['discount_value_minor', 'discountValueMinor'],
  ['tax_rate_bps', 'taxRateBps'],
  ['subtotal_minor', 'subtotalMinor'],
  ['discount_minor', 'discountMinor'],
  ['tax_minor', 'taxMinor'],
  ['total_minor', 'totalMinor'],
  ['payment_attempt', 'paymentAttempt'],
  ['psp_charge_id', 'pspChargeId'],
  ['failure_reason', 'failureReason'],
  ['version', 'version'],
  ['created_by', 'createdBy'],
  ['created_at', 'createdAt'],
  ['updated_at', 'updatedAt'],
  ['placed_at', 'placedAt'],
  ['paid_at', 'paidAt'],
  ['fulfilled_at', 'fulfilledAt'],
  ['cancelled_at', 'cancelledAt'],
];

// order_items.created_at / updated_at have DB defaults, but the order's time is more honest
type ItemRow = Prisma.OrderItemCreateManyInput & { createdAt: Date; updatedAt: Date };
const ITEM_COLUMNS: ColumnMap<ItemRow> = [
  ['workspace_id', 'workspaceId'],
  ['id', 'id'],
  ['order_id', 'orderId'],
  ['position', 'position'],
  ['product_id', 'productId'],
  ['sku', 'sku'],
  ['name', 'name'],
  ['unit_price_minor', 'unitPriceMinor'],
  ['quantity', 'quantity'],
  ['line_total_minor', 'lineTotalMinor'],
  ['created_at', 'createdAt'],
  ['updated_at', 'updatedAt'],
];

const EVENT_COLUMNS: ColumnMap<Prisma.OrderEventCreateManyInput> = [
  ['workspace_id', 'workspaceId'],
  ['id', 'id'],
  ['order_id', 'orderId'],
  ['type', 'type'],
  ['from_status', 'fromStatus'],
  ['to_status', 'toStatus'],
  ['actor', 'actor'],
  ['payload', 'payload'],
  ['created_at', 'createdAt'],
];

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function assertSafeTarget(databaseUrl: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to generate data in production');
  }
  const host = new URL(databaseUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to generate data on a non-local database host: ${host}`);
  }
}

/**
 * Creation times of every order, all tenants merged and sorted: rows land in the heap in time
 * order with tenants interleaved, as in production (loading tenant by tenant would cluster
 * each tenant's rows and flatter every per-tenant query in 2.2).
 */
function timeline(
  tenants: readonly TenantPlan[],
  until: Date,
  rng: Rng,
): { tenant: Uint16Array; at: Float64Array } {
  const total = tenants.reduce((sum, t) => sum + t.orderCount, 0);
  const tenant = new Uint16Array(total);
  const at = new Float64Array(total);
  // density ∝ 1 + (GROWTH − 1)·x on x ∈ [0, 1): inverse CDF of a linearly rising line
  const a = (GROWTH - 1) / 2;
  let n = 0;
  tenants.forEach((t, index) => {
    const from = t.startAt.getTime();
    const span = until.getTime() - from;
    for (let i = 0; i < t.orderCount; i++, n++) {
      const u = rng.next();
      const x = (-1 + Math.sqrt(1 + 4 * a * u * (1 + a))) / (2 * a);
      tenant[n] = index;
      at[n] = Math.floor(from + x * span);
    }
  });
  const order = Array.from({ length: total }, (_, i) => i).sort(
    (l, r) => (at[l] ?? 0) - (at[r] ?? 0) || l - r,
  );
  return {
    tenant: Uint16Array.from(order, (i) => tenant[i] ?? 0),
    at: Float64Array.from(order, (i) => at[i] ?? 0),
  };
}

async function seedTenants(
  prisma: PrismaClient,
  options: DatagenOptions,
  rng: Rng,
): Promise<TenantContext[]> {
  const existing = await prisma.workspace.count({ where: { slug: { startsWith: 'gen-' } } });
  if (existing > 0) {
    throw new Error('Generated tenants already exist: run `pnpm db:reset` first');
  }
  const plans = planTenants(options, rng);
  const people = await seedPeople(prisma, plans, rng);
  const contexts: TenantContext[] = [];
  for (const plan of plans) {
    const catalog = await seedCatalog(prisma, plan, rng);
    const tenantPeople = people.get(plan.id);
    if (!tenantPeople) throw new Error(`No people for ${plan.slug}`);
    contexts.push({ plan, people: tenantPeople, catalog });
  }
  const products = contexts.reduce((sum, c) => sum + c.plan.productCount, 0);
  log(`identity + catalog: ${String(plans.length)} tenants, ${String(products)} products`);
  return contexts;
}

/**
 * COPY into a month without a partition fails the whole chunk. The migration and the worker
 * job only cover the months around today; the generated history goes `months` back.
 */
async function ensureEventPartitions(pool: Pool, options: DatagenOptions): Promise<void> {
  const last = yearMonthOf(options.until);
  let month = yearMonthOf(windowStart(options));
  let count = 0;
  for (; monthIndex(month) <= monthIndex(last); month = addMonths(month, 1), count++) {
    await pool.query(createPartitionSql(month));
  }
  log(`order_events partitions: ${String(count)} months ready`);
}

/** One transaction per chunk: a failure loses at most this chunk. */
async function writeChunk(client: PoolClient, chunk: readonly OrderRows[]): Promise<Counts> {
  const items = chunk.flatMap((r) =>
    r.items.map((item) => ({
      ...item,
      createdAt: r.order.createdAt as Date,
      updatedAt: r.order.createdAt as Date,
    })),
  );
  const events = chunk.flatMap((r) => r.events);
  await client.query('BEGIN');
  try {
    // the WAL flush no longer gates each commit; a crash may lose the last chunks, never corrupt
    await client.query('SET LOCAL synchronous_commit = off');
    await copyRows(
      client,
      'orders',
      ORDER_COLUMNS,
      chunk.map((r) => r.order),
    );
    await copyRows(client, 'order_items', ITEM_COLUMNS, items);
    await copyRows(client, 'order_events', EVENT_COLUMNS, events);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  return { orders: chunk.length, items: items.length, events: events.length };
}

interface Counts {
  orders: number;
  items: number;
  events: number;
}

async function loadOrders(
  pool: Pool,
  contexts: readonly TenantContext[],
  options: DatagenOptions,
  rng: Rng,
): Promise<void> {
  const started = Date.now();
  const times = timeline(
    contexts.map((c) => c.plan),
    options.until,
    rng,
  );
  const total = times.at.length;
  const done: Counts = { orders: 0, items: 0, events: 0 };
  const client = await pool.connect();
  try {
    for (let start = 0; start < total; start += CHUNK) {
      const chunk: OrderRows[] = [];
      for (let i = start; i < Math.min(start + CHUNK, total); i++) {
        const ctx = contexts[times.tenant[i] ?? 0];
        if (!ctx) throw new Error('timeline points at an unknown tenant');
        chunk.push(buildOrder(ctx, new Date(times.at[i] ?? 0), options.until, rng));
      }
      const written = await writeChunk(client, chunk);
      done.orders += written.orders;
      done.items += written.items;
      done.events += written.events;
      if (done.orders % (CHUNK * 20) === 0 || done.orders === total) {
        const rate = Math.round(done.orders / ((Date.now() - started) / 1000));
        log(
          `orders ${String(done.orders)}/${String(total)} · items ${String(done.items)} · ` +
            `events ${String(done.events)} · ${String(rate)} orders/s`,
        );
      }
    }
  } finally {
    client.release();
  }
}

function databaseUrlFromEnv(): string {
  try {
    process.loadEnvFile('.env');
  } catch {
    // env comes from the shell
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  assertSafeTarget(databaseUrl);
  return databaseUrl;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = databaseUrlFromEnv();
  log(
    `datagen: scale=${options.scale} seed=${String(options.seed)} tenants=${String(options.tenants)} ` +
      `orders=${String(options.orders)} months=${String(options.months)} until=${options.until.toISOString()}`,
  );
  const started = Date.now();
  const rng = new Rng(options.seed);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const contexts = await seedTenants(prisma, options, rng);
    await ensureEventPartitions(pool, options);
    await loadOrders(pool, contexts, options, rng);
    log('VACUUM ANALYZE…');
    await analyzeAndReport(pool);
    log(`
done in ${String(Math.round((Date.now() - started) / 1000))} s`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}
`);
  process.exitCode = 1;
});
