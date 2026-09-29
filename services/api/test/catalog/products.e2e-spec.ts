// The product API end to end (CAT-001…007), as an ADMIN (who may manage products; the role
// matrix itself is 1.8). Lists use their own tenant so counts are exact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { productFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { productPath, productsPath } from '../helpers/paths';
import { createTenant } from '../helpers/tenant';
import { USER_ACME_ADMIN, USER_GLOBEX_ADMIN, WS_ACME, WS_GLOBEX } from '../seed/ids';
import { testDb } from '../setup/db';

let api: ApiApp;
beforeAll(async () => {
  api = await createApiApp();
});
afterAll(() => api.close());

const admin = asUser(USER_ACME_ADMIN);
const valid = (overrides: Record<string, unknown> = {}) => ({
  sku: `SKU-${String(Math.random()).slice(2, 10)}`,
  name: 'Desk lamp',
  description: 'Warm light',
  priceMinor: 4999,
  ...overrides,
});
const create = (body: unknown, ws = WS_ACME, as = admin) =>
  api
    .http()
    .post(productsPath(ws))
    .set(as)
    .send(body as object);
const get = async (id: string, ws = WS_ACME, as = admin) =>
  (await api.http().get(productPath(ws, id)).set(as).expect(200)).body as Record<string, unknown>;
const fieldPaths = (body: unknown) =>
  (body as { details: { fields: { path: string }[] } }).details.fields.map((f) => f.path);

describe('POST /products (CAT-001, CAT-003, CAT-007)', () => {
  it('creates an ACTIVE product: 201 { id } + Location, price as money in the workspace currency', async () => {
    const body = valid({ sku: 'LAMP-1' });
    const res = await create(body).expect(201);
    const id = (res.body as { id: string }).id;
    expect(res.headers.location).toBe(productPath(WS_ACME, id));

    expect(await get(id)).toEqual({
      id,
      sku: 'LAMP-1',
      name: 'Desk lamp',
      description: 'Warm light',
      price: { amountMinor: 4999, currency: 'EUR' },
      status: 'ACTIVE',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('prices globex products in USD', async () => {
    const as = asUser(USER_GLOBEX_ADMIN);
    const res = await create(valid(), WS_GLOBEX, as).expect(201);
    expect((await get((res.body as { id: string }).id, WS_GLOBEX, as)).price).toEqual({
      amountMinor: 4999,
      currency: 'USD',
    });
  });

  it('accepts a missing description as null', async () => {
    const body: Partial<ReturnType<typeof valid>> = valid();
    delete body.description;
    const res = await create(body).expect(201);
    expect((await get((res.body as { id: string }).id)).description).toBeNull();
  });

  it.each([
    ['sku empty', { sku: '' }, 'sku'],
    ['sku of 65 chars', { sku: 'A'.repeat(65) }, 'sku'],
    ['sku with a space', { sku: 'NO SPACE' }, 'sku'],
    ['name empty', { name: '' }, 'name'],
    ['name of 201 chars', { name: 'n'.repeat(201) }, 'name'],
    ['description of 2001 chars', { description: 'd'.repeat(2001) }, 'description'],
    ['price 0', { priceMinor: 0 }, 'priceMinor'],
    ['price above 100 000 000', { priceMinor: 100_000_001 }, 'priceMinor'],
    ['price not an integer', { priceMinor: 9.99 }, 'priceMinor'],
  ])('400 for %s', async (_name, overrides, path) => {
    const res = await create(valid(overrides)).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fieldPaths(res.body)).toContain(path);
  });

  it('accepts the boundaries: sku of 64, price 1 and 100 000 000', async () => {
    await create(valid({ sku: `${'B'.repeat(63)}1`, priceMinor: 1 })).expect(201);
    await create(valid({ priceMinor: 100_000_000 })).expect(201);
  });
});

describe('SKU uniqueness through HTTP (CAT-002)', () => {
  it('409 PRODUCT_SKU_TAKEN in the same workspace, 201 in another', async () => {
    await create(valid({ sku: 'TAKEN-1' })).expect(201);

    const res = await create(valid({ sku: 'TAKEN-1' })).expect(409);
    expect(res.body).toMatchObject({ code: 'PRODUCT_SKU_TAKEN' });

    await create(valid({ sku: 'TAKEN-1' }), WS_GLOBEX, asUser(USER_GLOBEX_ADMIN)).expect(201);
  });
});

describe('PATCH /products/{id} (CAT-004)', () => {
  it('updates name, description and price: 204', async () => {
    const product = await productFactory.create({ description: 'old' });

    await api
      .http()
      .patch(productPath(WS_ACME, product.id))
      .set(admin)
      .send({ name: 'Renamed', description: 'new', priceMinor: 777 })
      .expect(204);

    expect(await get(product.id)).toMatchObject({
      name: 'Renamed',
      description: 'new',
      price: { amountMinor: 777, currency: 'EUR' },
      sku: product.sku,
    });
  });

  it('clears the description with null', async () => {
    const product = await productFactory.create({ description: 'to be cleared' });
    await api
      .http()
      .patch(productPath(WS_ACME, product.id))
      .set(admin)
      .send({ description: null })
      .expect(204);
    expect((await get(product.id)).description).toBeNull();
  });

  it('refuses to change the sku: 400, nothing written', async () => {
    const product = await productFactory.create();

    const res = await api
      .http()
      .patch(productPath(WS_ACME, product.id))
      .set(admin)
      .send({ sku: 'NEW-SKU', name: 'Also renamed' })
      .expect(400);

    expect(fieldPaths(res.body)).toContain('sku');
    expect(await testDb().product.findFirstOrThrow({ where: { id: product.id } })).toMatchObject({
      sku: product.sku,
      name: product.name,
    });
  });

  it('404 PRODUCT_NOT_FOUND for an unknown product', async () => {
    const res = await api
      .http()
      .patch(productPath(WS_ACME, '01990000-0000-7000-8000-ffffffffffff'))
      .set(admin)
      .send({ name: 'x' })
      .expect(404);
    expect(res.body).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
  });
});

describe('POST /products/{id}/archive (CAT-005)', () => {
  it('archives: 204; archiving again is a no-op 204; the product is never deleted', async () => {
    const product = await productFactory.create();

    await api
      .http()
      .post(`${productPath(WS_ACME, product.id)}/archive`)
      .set(admin)
      .expect(204);
    await api
      .http()
      .post(`${productPath(WS_ACME, product.id)}/archive`)
      .set(admin)
      .expect(204);

    expect((await get(product.id)).status).toBe('ARCHIVED');
  });
});

describe('GET /products (CAT-006)', () => {
  it('lists newest first, filters by status, pages with nextCursor without repeats', async () => {
    const t = await createTenant('ADMIN'); // already has 1 ACTIVE product
    const created = [t.productId];
    for (let i = 0; i < 4; i++) {
      created.push((await productFactory.create({ workspaceId: t.workspaceId })).id);
    }
    const archived = await productFactory.create({
      workspaceId: t.workspaceId,
      status: 'ARCHIVED',
    });
    created.push(archived.id);

    const all = (await api.http().get(productsPath(t.workspaceId)).set(t.as).expect(200)).body as {
      items: { id: string }[];
    };
    expect(all.items.map((p) => p.id)).toEqual([...created].reverse());

    const onlyArchived = (
      await api
        .http()
        .get(productsPath(t.workspaceId))
        .query({ status: 'ARCHIVED' })
        .set(t.as)
        .expect(200)
    ).body as { items: { id: string }[] };
    expect(onlyArchived.items.map((p) => p.id)).toEqual([archived.id]);

    const first = (
      await api.http().get(productsPath(t.workspaceId)).query({ limit: 4 }).set(t.as).expect(200)
    ).body as { items: { id: string }[]; nextCursor: string };
    const second = (
      await api
        .http()
        .get(productsPath(t.workspaceId))
        .query({ limit: 4, cursor: first.nextCursor })
        .set(t.as)
        .expect(200)
    ).body as { items: { id: string }[]; nextCursor: string | null };
    expect([...first.items, ...second.items].map((p) => p.id)).toEqual([...created].reverse());
    expect(second.nextCursor).toBeNull();
  });

  it('lists 1 and 20 products with the same number of queries (N+1 guard)', async () => {
    const one = await createTenant('ADMIN');
    const twenty = await createTenant('ADMIN');
    await productFactory.createList(19, { workspaceId: twenty.workspaceId });

    const list = (t: typeof one) =>
      api.http().get(productsPath(t.workspaceId)).set(t.as).expect(200);
    const forOne = await api.countQueries(() => list(one));
    const forTwenty = await api.countQueries(() => list(twenty));

    expect(forTwenty).toBe(forOne);
    expect(forTwenty).toBeLessThanOrEqual(3);
  });
});
