// The catalog cache end to end (CCH-001…003; docs/adr/0010-catalog-cache.md). Every test gets
// its own tenant: a tenant is a cache namespace, so nothing cached by one test reaches another.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisCache } from '@infra/cache/redis-cache';

import { productFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { productPath, productsPath } from '../helpers/paths';
import { createTenant, type Tenant } from '../helpers/tenant';
import { testDb } from '../setup/db';

interface Product {
  id: string;
  name: string;
  status: string;
  price: { amountMinor: number };
}

let api: ApiApp;
beforeAll(async () => {
  api = await createApiApp();
});
afterAll(() => api.close());

const getProduct = async (t: Tenant, id = t.productId): Promise<Product> =>
  (await api.http().get(productPath(t.workspaceId, id)).set(t.as).expect(200)).body as Product;
const listProducts = async (t: Tenant, query: Record<string, string> = {}): Promise<Product[]> =>
  (
    (await api.http().get(productsPath(t.workspaceId)).query(query).set(t.as).expect(200)).body as {
      items: Product[];
    }
  ).items;

/** What `work` added to the counters of the cache. */
async function cacheDelta(work: () => Promise<unknown>): Promise<{ hits: number; loads: number }> {
  const before = api.get(RedisCache).stats();
  await work();
  const after = api.get(RedisCache).stats();
  return { hits: after.hits - before.hits, loads: after.loads - before.loads };
}

describe('CCH-001 a repeated read is served from the cache', () => {
  it('answers the second GET of a product and of a list without the catalog queries', async () => {
    const t = await createTenant('ADMIN');
    const first = await api.countQueries(() => getProduct(t));
    const firstBody = await getProduct(t);

    const second = await api.countQueries(async () => {
      expect(await cacheDelta(() => getProduct(t))).toEqual({ hits: 1, loads: 0 });
    });
    expect(second).toBeLessThan(first);
    expect(await getProduct(t)).toEqual(firstBody);

    expect(await cacheDelta(() => listProducts(t))).toEqual({ hits: 0, loads: 1 });
    expect(await cacheDelta(() => listProducts(t))).toEqual({ hits: 1, loads: 0 });
    // another filter is another key
    expect(await cacheDelta(() => listProducts(t, { status: 'ACTIVE' }))).toMatchObject({
      loads: 1,
    });
  });

  it('does not see a row changed past the API until something invalidates', async () => {
    const t = await createTenant('ADMIN');
    await getProduct(t);
    await testDb().product.update({
      where: { workspaceId_id: { workspaceId: t.workspaceId, id: t.productId } },
      data: { name: 'Changed by the owner' },
    });

    expect((await getProduct(t)).name).not.toBe('Changed by the owner');

    const other = await productFactory.create({ workspaceId: t.workspaceId });
    await api
      .http()
      .post(`${productPath(t.workspaceId, other.id)}/archive`)
      .set(t.as)
      .expect(204);
    expect((await getProduct(t)).name).toBe('Changed by the owner');
  });

  it('does not cache a missing product', async () => {
    const t = await createTenant('ADMIN');
    const missing = productPath(t.workspaceId, '01990000-0000-7000-8000-ffffffffffff');

    await api.http().get(missing).set(t.as).expect(404);

    expect(await cacheDelta(() => api.http().get(missing).set(t.as).expect(404))).toEqual({
      hits: 0,
      loads: 1,
    });
  });
});

describe('CCH-002 a change through the API is visible in the next read', () => {
  it('PATCH: the product and the list show the new price', async () => {
    const t = await createTenant('ADMIN');
    await getProduct(t);
    await listProducts(t);

    await api
      .http()
      .patch(productPath(t.workspaceId, t.productId))
      .set(t.as)
      .send({ priceMinor: 2500 })
      .expect(204);

    expect((await getProduct(t)).price.amountMinor).toBe(2500);
    expect((await listProducts(t)).map((p) => p.price.amountMinor)).toEqual([2500]);
  });

  it('POST: the list shows the new product', async () => {
    const t = await createTenant('ADMIN');
    await listProducts(t);

    const created = await api
      .http()
      .post(productsPath(t.workspaceId))
      .set(t.as)
      .send({ sku: 'NEW-1', name: 'New', priceMinor: 100 })
      .expect(201);

    expect((await listProducts(t)).map((p) => p.id)).toEqual([
      (created.body as { id: string }).id,
      t.productId,
    ]);
  });

  it('archive: the product and the filtered lists follow', async () => {
    const t = await createTenant('ADMIN');
    await getProduct(t);
    await listProducts(t, { status: 'ACTIVE' });
    await listProducts(t, { status: 'ARCHIVED' });

    await api
      .http()
      .post(`${productPath(t.workspaceId, t.productId)}/archive`)
      .set(t.as)
      .expect(204);

    expect((await getProduct(t)).status).toBe('ARCHIVED');
    expect(await listProducts(t, { status: 'ACTIVE' })).toEqual([]);
    expect((await listProducts(t, { status: 'ARCHIVED' })).map((p) => p.id)).toEqual([t.productId]);
  });
});

describe('CCH-003 the cache keeps tenants apart', () => {
  it('serves each workspace its own list and never a cached product of another', async () => {
    const [mine, theirs] = [await createTenant('ADMIN'), await createTenant('ADMIN')];
    await listProducts(mine);
    await getProduct(mine);

    expect((await listProducts(theirs)).map((p) => p.id)).toEqual([theirs.productId]);
    // their member asks for my cached product inside their own workspace
    await api
      .http()
      .get(productPath(theirs.workspaceId, mine.productId))
      .set(theirs.as)
      .expect(404);
    // and has no way into my workspace: the membership guard runs before the cache
    await api.http().get(productPath(mine.workspaceId, mine.productId)).set(theirs.as).expect(404);
  });

  it('a change in one workspace leaves the cache of another warm', async () => {
    const [mine, theirs] = [await createTenant('ADMIN'), await createTenant('ADMIN')];
    await getProduct(theirs);

    await api
      .http()
      .patch(productPath(mine.workspaceId, mine.productId))
      .set(mine.as)
      .send({ name: 'Mine, renamed' })
      .expect(204);

    expect(await cacheDelta(() => getProduct(theirs))).toEqual({ hits: 1, loads: 0 });
  });
});
