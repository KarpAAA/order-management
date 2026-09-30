// GET /orders (ORD-023) and the N+1 guard of the conventions ("every list endpoint has a
// query-count assertion"). Every test gets its own tenant, so counts are exact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrderStatus } from '@infra/database/generated/prisma/client';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { orderPath, ordersPath } from '../helpers/paths';
import { createTenant, type Tenant } from '../helpers/tenant';
import { testDb } from '../setup/db';

let api: ApiApp;
beforeAll(async () => {
  api = await createApiApp();
});
afterAll(() => api.close());

interface Page {
  items: { id: string; status: string }[];
  nextCursor: string | null;
}

async function createOrders(t: Tenant, count: number, status?: OrderStatus): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push((await orderFactory.create({ ...t.order, ...(status && { status }) })).id);
  }
  return ids;
}

async function list(t: Tenant, query: Record<string, string | number> = {}): Promise<Page> {
  const { body } = await api
    .http()
    .get(ordersPath(t.workspaceId))
    .query(query)
    .set(t.as)
    .expect(200);
  return body as Page;
}

describe('GET /orders (ORD-023)', () => {
  it('lists newest first as { items, nextCursor } with summary fields', async () => {
    const t = await createTenant();
    const [first, second, third] = await createOrders(t, 3);

    const page = await list(t);

    expect(page.items.map((o) => o.id)).toEqual([third, second, first]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toEqual({
      id: third,
      status: 'DRAFT',
      total: { amountMinor: 1200, currency: 'EUR' },
      paymentAttempt: 0,
      version: 0,
      createdBy: t.userId,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('filters by ?status=', async () => {
    const t = await createTenant();
    const paid = await createOrders(t, 2, 'PAID');
    await createOrders(t, 2, 'DRAFT');

    const page = await list(t, { status: 'PAID' });

    expect(page.items.map((o) => o.id).sort()).toEqual([...paid].sort());
    expect(page.items.every((o) => o.status === 'PAID')).toBe(true);
  });

  it('pages 20 by default; following nextCursor never repeats or skips an order', async () => {
    const t = await createTenant();
    const created = await createOrders(t, 25);

    const first = await list(t);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await list(t, { cursor: first.nextCursor! });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((o) => o.id);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual([...created].reverse());
  });

  it('pages through orders sharing one created_at by the id tiebreak, none repeated or skipped', async () => {
    const t = await createTenant();
    const created = await createOrders(t, 5);
    await testDb().order.updateMany({
      where: { workspaceId: t.workspaceId },
      data: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(t, { limit: 2, ...(cursor && { cursor }) });
      seen.push(...page.items.map((o) => o.id));
      cursor = page.nextCursor;
    } while (cursor);

    // equal timestamps → id DESC; UUIDv7 ids grow with creation, so newest created first
    expect(seen).toEqual([...created].reverse());
  });

  it('accepts limit 1…100 and rejects anything else with 400', async () => {
    const t = await createTenant();
    await createOrders(t, 2);

    expect((await list(t, { limit: 1 })).items).toHaveLength(1);
    expect((await list(t, { limit: 100 })).items).toHaveLength(2);
    for (const limit of [0, 101, 'many']) {
      const res = await api
        .http()
        .get(ordersPath(t.workspaceId))
        .query({ limit })
        .set(t.as)
        .expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('rejects a malformed cursor with 400 INVALID_CURSOR', async () => {
    const t = await createTenant();

    const res = await api
      .http()
      .get(ordersPath(t.workspaceId))
      .query({ cursor: 'bm90LWEtY3Vyc29y' }) // base64url of "not-a-cursor"
      .set(t.as)
      .expect(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

describe('query count (N+1 guard)', () => {
  it('lists the history of 1 event and of 4 events with the same number of queries', async () => {
    const t = await createTenant();
    const draft = await orderFactory.create(t.order); // ORDER_CREATED
    const fulfilled = await orderFactory.create({ ...t.order, status: 'FULFILLED' }); // + placed, paid, fulfilled
    const events = (id: string) =>
      api
        .http()
        .get(`${orderPath(t.workspaceId, id)}/events`)
        .set(t.as)
        .expect(200);

    const forOne = await api.countQueries(() => events(draft.id));
    const forFour = await api.countQueries(() => events(fulfilled.id));

    expect(forOne).toBeGreaterThan(0);
    expect(forFour).toBe(forOne);
    expect(forFour).toBeLessThanOrEqual(3);
  });

  it('lists 1 order and 20 orders with the same, small number of queries', async () => {
    const one = await createTenant();
    const twenty = await createTenant();
    await createOrders(one, 1);
    await createOrders(twenty, 20);

    const forOne = await api.countQueries(() => list(one));
    const forTwenty = await api.countQueries(() => list(twenty));

    expect(forOne).toBeGreaterThan(0); // query events are on: the guard cannot pass empty
    expect(forTwenty).toBe(forOne); // does not grow with the page
    expect(forTwenty).toBeLessThanOrEqual(3); // membership check + the list
  });
});
