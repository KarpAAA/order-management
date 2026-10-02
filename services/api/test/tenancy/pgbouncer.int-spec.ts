// The pooled path (TEN-013): the same application code with PgBouncer in transaction mode
// between it and Postgres (docs/adr/0008-pgbouncer-transaction-mode.md). A server connection
// serves one client per transaction and then the next client, so whatever is set on it must
// end with the transaction. The second describe shows on a pool of ONE server connection what
// a session-level setting would do, with no application code in the way.
import { TransactionHost } from '@nestjs-cls/transactional';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { TenantContext } from '@common/tenancy/tenant-context';
import {
  SCOPED_PRISMA,
  type ScopedPrismaClient,
  type WriteDb,
} from '@infra/database/database.tokens';
import { PrismaService } from '@infra/database/prisma.service';
import { newId } from '@shared/domain/id';

import { createIntModule, type IntModule } from '../helpers/int-module';
import { WS_ACME, WS_GLOBEX } from '../seed/ids';
import { databaseUrl } from '../setup/database-url';
import { testDb } from '../setup/db';
import { ONE_CONNECTION_DB } from '../setup/pgbouncer';

let app: IntModule;
let scoped: ScopedPrismaClient;
let first: Client;
let second: Client;

beforeAll(async () => {
  // test/setup/db.ts pointed DATABASE_URL at this file's database on Postgres itself: the
  // app of this file reaches the same database through PgBouncer instead
  const fileDb = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  process.env.DATABASE_URL = databaseUrl(inject('pgBouncerUrl'), fileDb);
  app = await createIntModule({ providers: [] });
  scoped = app.get<ScopedPrismaClient>(SCOPED_PRISMA);

  const oneConnection = databaseUrl(inject('pgBouncerUrl'), ONE_CONNECTION_DB);
  first = new Client({ connectionString: oneConnection });
  second = new Client({ connectionString: oneConnection });
  await Promise.all([first.connect(), second.connect()]);
});
afterAll(async () => {
  await Promise.all([first.end(), second.end()]);
  await app.close();
});

const backendPid = async (client: Client): Promise<number> =>
  (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;

const workspaceSetting = async (client: Client): Promise<string | null> =>
  (
    await client.query<{ value: string | null }>(
      `SELECT current_setting('app.workspace_id', true) AS value`,
    )
  ).rows[0]?.value ?? null;

describe('TEN-013 the application through PgBouncer in transaction mode', () => {
  it('gives interleaved readers of two tenants their own rows on shared server connections', async () => {
    const tenant = app.get(TenantContext);
    // 40 reads at once, the application pool of 10 on 5 server connections
    const reads = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const workspaceId = i % 2 === 0 ? WS_ACME : WS_GLOBEX;
        return tenant.runInWorkspace(workspaceId, async () => ({
          workspaceId,
          seen: await scoped.product.findMany({ select: { workspaceId: true } }),
        }));
      }),
    );

    for (const { workspaceId, seen } of reads) {
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen.map((row) => row.workspaceId))).toEqual(new Set([workspaceId]));
    }
  });

  it('keeps one server connection for the whole of a transaction and commits it', async () => {
    const sku = 'POOLED-TX';
    const pid = () => app.get<WriteDb>(TransactionHost).tx.$queryRaw<{ pid: number }[]>`
      SELECT pg_backend_pid() AS pid`;

    const seen = await app.inWorkspaceTx(WS_ACME, async () => {
      const tx = app.get<WriteDb>(TransactionHost).tx;
      const [before] = await pid();
      await tx.product.create({
        data: { workspaceId: WS_ACME, id: newId(), sku, name: 'x', priceMinor: 1n },
      });
      const [after] = await pid();
      return {
        samePid: before?.pid === after?.pid,
        inTx: await tx.product.count({ where: { sku } }),
      };
    });

    expect(seen).toEqual({ samePid: true, inTx: 1 });
    expect(await testDb().product.count({ where: { sku } })).toBe(1);
    await testDb().product.deleteMany({ where: { sku } });
  });

  it('leaves no tenant behind on the server connections it used', async () => {
    const prisma = app.get(PrismaService);
    // no tenant in these: a tenant left on a connection by the tests above would show rows
    const counts = await Promise.all(
      Array.from(
        { length: 10 },
        () => prisma.$queryRaw<{ rows: number }[]>`SELECT count(*)::int AS rows FROM products`,
      ),
    );

    expect(counts.flat().map((count) => count.rows)).toEqual(Array<number>(10).fill(0));
  });
});

describe('TEN-013 a setting on a server connection that two clients share', () => {
  it('serves both clients on the same Postgres backend', async () => {
    expect(await backendPid(first)).toBe(await backendPid(second));
  });

  it('ends with the transaction when it is transaction-local, as the application sets it', async () => {
    await first.query('BEGIN');
    await first.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_ACME]);
    const inside = await workspaceSetting(first);
    await first.query('COMMIT');

    expect(inside).toBe(WS_ACME);
    expect(await workspaceSetting(second)).toBeFalsy(); // NULL, or '' once it was ever set
  });

  it('reaches the next client when it is session-level: PgBouncer does not reset it', async () => {
    await first.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_ACME]);
    try {
      expect(await workspaceSetting(second)).toBe(WS_ACME);
    } finally {
      await first.query(`SELECT set_config('app.workspace_id', '', false)`);
    }
  });
});
