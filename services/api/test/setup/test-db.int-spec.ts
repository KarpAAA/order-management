import { describe, expect, it } from 'vitest';

import {
  PRODUCT_ACME_ACTIVE,
  PRODUCT_ACME_ARCHIVED,
  PRODUCT_GLOBEX_ACTIVE,
  USER_BOTH,
  WS_ACME,
  WS_GLOBEX,
} from '../seed/ids';

import { TEMPLATE_DB } from './database-url';
import { testDb, truncateAll } from './db';

describe('test database per file', () => {
  it('runs this file in its own copy of the template', async () => {
    const [{ name }] = await testDb().$queryRaw<
      [{ name: string }]
    >`SELECT current_database() AS name`;
    expect(name).toMatch(/^test_[0-9a-f]{32}$/);
    expect(name).not.toBe(TEMPLATE_DB);
    expect(process.env.DATABASE_URL).toContain(`/${name}`);
  });

  it('starts from the test seed: identity world, three products, no orders', async () => {
    const db = testDb();
    const workspaces = await db.workspace.findMany({ orderBy: { slug: 'asc' } });
    expect(workspaces.map((w) => w.id)).toEqual([WS_ACME, WS_GLOBEX]);
    expect(await db.user.count()).toBe(9);
    expect(await db.membership.count()).toBe(10);

    const both = await db.membership.findMany({ where: { userId: USER_BOTH } });
    expect(Object.fromEntries(both.map((m) => [m.workspaceId, m.role]))).toEqual({
      [WS_ACME]: 'MEMBER',
      [WS_GLOBEX]: 'VIEWER',
    });

    const products = await db.product.findMany({ orderBy: { id: 'asc' } });
    expect(products.map((p) => [p.id, p.workspaceId, p.status])).toEqual([
      [PRODUCT_ACME_ACTIVE, WS_ACME, 'ACTIVE'],
      [PRODUCT_ACME_ARCHIVED, WS_ACME, 'ARCHIVED'],
      [PRODUCT_GLOBEX_ACTIVE, WS_GLOBEX, 'ACTIVE'],
    ]);
    expect(await db.order.count()).toBe(0);
  });

  it('owns its rows: the same SKU inserted by another file does not collide', async () => {
    // factories.int-spec.ts inserts ISOLATION-1 too, in parallel, into ITS database
    await testDb().product.create({
      data: {
        workspaceId: WS_ACME,
        id: '01990000-0000-7000-8000-f10000000100',
        sku: 'ISOLATION-1',
        name: 'x',
        priceMinor: 1n,
      },
    });
    expect(await testDb().product.count({ where: { sku: 'ISOLATION-1' } })).toBe(1);
  });
});

describe('truncateAll', () => {
  it('drops what the file added and restores the seed', async () => {
    await truncateAll();
    const db = testDb();
    expect(await db.product.count({ where: { sku: 'ISOLATION-1' } })).toBe(0);
    expect(await db.product.count()).toBe(3);
    expect(await db.user.count()).toBe(9);
  });
});
