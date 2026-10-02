// Tenant isolation inside Postgres (TEN-009…TEN-012): Row-Level Security for the role the
// application connects as, with no application code in the way — plain SQL on a `pg` client,
// and the unscoped Prisma client that used to see every tenant.
// `migrate diff` does not see grants or policies: the last describe is their only guard.
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '@infra/database/prisma.service';
import { newId } from '@shared/domain/id';

import { createIntModule, type IntModule } from '../helpers/int-module';
import {
  PRODUCT_ACME_ACTIVE,
  PRODUCT_GLOBEX_ACTIVE,
  USER_ACME_OWNER,
  USER_BOTH,
  WS_ACME,
  WS_GLOBEX,
} from '../seed/ids';
import { APP_ROLE } from '../setup/database-url';
import { testDb } from '../setup/db';

let app: IntModule;
let sql: Client;

beforeAll(async () => {
  app = await createIntModule({ providers: [] });
  // set by test/setup/db.ts: this file's database, as the application role
  sql = new Client({ connectionString: process.env.DATABASE_URL });
  await sql.connect();
});
afterAll(async () => {
  await sql.end();
  await app.close();
});

type Setting = 'app.workspace_id' | 'app.user_id';

/** One transaction as the application role, with `setting` local to it; always rolled back. */
async function inTransaction<T>(
  context: Partial<Record<Setting, string>>,
  work: () => Promise<T>,
): Promise<T> {
  await sql.query('BEGIN');
  try {
    for (const [setting, value] of Object.entries(context)) {
      await sql.query('SELECT set_config($1, $2, true)', [setting, value]);
    }
    return await work();
  } finally {
    await sql.query('ROLLBACK');
  }
}

const productIds = async (): Promise<string[]> =>
  (await sql.query<{ id: string }>('SELECT id FROM products')).rows.map((row) => row.id);

const insertProduct = (workspaceId: string) =>
  sql.query(
    `INSERT INTO products (workspace_id, id, sku, name, price_minor, updated_at)
     VALUES ($1, $2, 'RLS-1', 'x', 1, now())`,
    [workspaceId, newId()],
  );

const RLS_VIOLATION = /row-level security policy for table "products"/;

describe('TEN-009 without a tenant the database shows and accepts nothing', () => {
  it('returns no row of a tenant table', async () => {
    expect(await productIds()).toEqual([]);
  });

  it('returns no row through the unscoped Prisma client either', async () => {
    const unscoped = app.get(PrismaService);

    expect(await unscoped.product.findMany({ select: { id: true } })).toEqual([]);
    expect(await unscoped.order.count()).toBe(0);
  });

  it('refuses a write', async () => {
    await expect(insertProduct(WS_ACME)).rejects.toThrow(RLS_VIOLATION);
  });

  it('forgets the tenant when the transaction ends: a pooled connection carries nothing over', async () => {
    const inside = await inTransaction({ 'app.workspace_id': WS_ACME }, productIds);

    expect(inside).toContain(PRODUCT_ACME_ACTIVE);
    expect(await productIds()).toEqual([]);
  });
});

describe('TEN-010 with a tenant the database shows and accepts only its rows', () => {
  it('returns the rows of that tenant, with no filter in the query', async () => {
    const ids = await inTransaction({ 'app.workspace_id': WS_ACME }, productIds);

    expect(ids).toContain(PRODUCT_ACME_ACTIVE);
    expect(ids).not.toContain(PRODUCT_GLOBEX_ACTIVE);
  });

  it("cannot update or delete another tenant's row", async () => {
    const touched = await inTransaction({ 'app.workspace_id': WS_ACME }, async () => {
      const updated = await sql.query(`UPDATE products SET name = 'hijacked' WHERE id = $1`, [
        PRODUCT_GLOBEX_ACTIVE,
      ]);
      const deleted = await sql.query('DELETE FROM products WHERE id = $1', [
        PRODUCT_GLOBEX_ACTIVE,
      ]);
      return [updated.rowCount, deleted.rowCount];
    });

    expect(touched).toEqual([0, 0]);
  });

  it('refuses to write a row of another tenant', async () => {
    await expect(
      inTransaction({ 'app.workspace_id': WS_ACME }, () => insertProduct(WS_GLOBEX)),
    ).rejects.toThrow(RLS_VIOLATION);
  });

  it('refuses to move a row to another tenant', async () => {
    await expect(
      inTransaction({ 'app.workspace_id': WS_ACME }, () =>
        sql.query('UPDATE products SET workspace_id = $1 WHERE id = $2', [
          WS_GLOBEX,
          PRODUCT_ACME_ACTIVE,
        ]),
      ),
    ).rejects.toThrow(RLS_VIOLATION);
  });

  it('accepts a write of its own tenant', async () => {
    const inserted = await inTransaction({ 'app.workspace_id': WS_ACME }, () =>
      insertProduct(WS_ACME),
    );

    expect(inserted.rowCount).toBe(1);
  });
});

describe('TEN-011 a user reads their own memberships across workspaces, and only reads', () => {
  const memberships = async () =>
    (
      await sql.query<{ workspace_id: string; user_id: string }>(
        'SELECT workspace_id, user_id FROM memberships',
      )
    ).rows;

  it('sees every workspace they belong to and no other member', async () => {
    const rows = await inTransaction({ 'app.user_id': USER_BOTH }, memberships);

    expect(rows.map((row) => row.workspace_id).sort()).toEqual([WS_ACME, WS_GLOBEX].sort());
    expect(new Set(rows.map((row) => row.user_id))).toEqual(new Set([USER_BOTH]));
  });

  it('cannot add themselves to a workspace', async () => {
    await expect(
      inTransaction({ 'app.user_id': USER_ACME_OWNER }, () =>
        sql.query(
          `INSERT INTO memberships (workspace_id, id, user_id, role, updated_at)
           VALUES ($1, $2, $3, 'OWNER', now())`,
          [WS_GLOBEX, newId(), USER_ACME_OWNER],
        ),
      ),
    ).rejects.toThrow(/row-level security policy for table "memberships"/);
  });
});

describe('TEN-012 the application role and its privileges', () => {
  it('is not a superuser, cannot bypass row security and owns no table', async () => {
    const [role] = await testDb().$queryRaw<{ super: boolean; bypass: boolean; owned: number }[]>`
      SELECT rolsuper AS super, rolbypassrls AS bypass,
             (SELECT count(*)::int FROM pg_class WHERE relowner = pg_roles.oid) AS owned
        FROM pg_roles WHERE rolname = ${APP_ROLE}`;

    expect(role).toEqual({ super: false, bypass: false, owned: 0 });
    const current = await sql.query<{ name: string }>('SELECT current_user AS name');
    expect(current.rows[0]?.name).toBe(APP_ROLE);
  });

  it('every table with a workspace_id has row security on and a policy', async () => {
    const unprotected = await testDb().$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND (NOT c.relrowsecurity
              OR NOT EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = c.oid))`;

    expect(unprotected).toEqual([]);
  });

  it('reaches every table of the schema, but no partition and not the migration history', async () => {
    const tables = await testDb().$queryRaw<
      { name: string; partition: boolean; granted: boolean }[]
    >`
      SELECT c.relname AS name, c.relispartition AS partition,
             has_table_privilege(${APP_ROLE}, c.oid, 'SELECT') AS granted
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`;
    const direct = (table: { name: string; partition: boolean }) =>
      !table.partition && table.name !== '_prisma_migrations';

    expect(tables.filter((t) => direct(t) && !t.granted).map((t) => t.name)).toEqual([]);
    expect(tables.filter((t) => !direct(t) && t.granted).map((t) => t.name)).toEqual([]);
    expect(tables.some((t) => t.partition)).toBe(true);
  });

  it('cannot run DDL on the history table: partitions go through the two functions', async () => {
    await expect(
      sql.query(
        `CREATE TABLE order_events_2031_01 PARTITION OF order_events
           FOR VALUES FROM ('2031-01-01 00:00:00+00') TO ('2031-02-01 00:00:00+00')`,
      ),
    ).rejects.toThrow(/must be owner of table order_events|permission denied/);
  });
});
