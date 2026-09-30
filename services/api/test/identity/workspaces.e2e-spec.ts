// Workspaces and members (WS-001…004), as the OWNER of a workspace created through the API.
// Who may add whom is the role matrix of 1.8.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { membershipFactory, userFactory, workspaceFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { V1, workspacePath } from '../helpers/paths';

let api: ApiApp;
beforeAll(async () => {
  api = await createApiApp();
});
afterAll(() => api.close());

let slugs = 0;
const valid = (overrides: Record<string, unknown> = {}) => ({
  name: 'Initech',
  slug: `initech-${String((slugs += 1))}`,
  currency: 'EUR',
  taxRateBps: 1900,
  ...overrides,
});

/** A new user who creates a workspace through the API and so becomes its OWNER. */
async function ownerOfNewWorkspace() {
  const owner = await userFactory.create();
  const as = asUser(owner.id);
  const res = await api.http().post(`${V1}/workspaces`).set(as).send(valid()).expect(201);
  return { owner, as, workspaceId: (res.body as { id: string }).id };
}

describe('POST /workspaces (WS-001, WS-002)', () => {
  it('creates the workspace, 201 { id } + Location, and makes the creator its OWNER', async () => {
    const user = await userFactory.create();
    const as = asUser(user.id);
    const body = valid({ slug: 'initech-main' });

    const res = await api.http().post(`${V1}/workspaces`).set(as).send(body).expect(201);
    const id = (res.body as { id: string }).id;
    expect(res.headers.location).toBe(workspacePath(id));

    const { body: workspace } = await api.http().get(workspacePath(id)).set(as).expect(200);
    expect(workspace).toEqual({
      id,
      name: 'Initech',
      slug: 'initech-main',
      currency: 'EUR',
      taxRateBps: 1900,
      myRole: 'OWNER',
      createdAt: expect.any(String),
    });
  });

  it('409 WORKSPACE_SLUG_TAKEN for a slug in use', async () => {
    const user = await userFactory.create();
    const res = await api
      .http()
      .post(`${V1}/workspaces`)
      .set(asUser(user.id))
      .send(valid({ slug: 'acme' }))
      .expect(409);
    expect(res.body).toMatchObject({ code: 'WORKSPACE_SLUG_TAKEN' });
  });

  it.each([
    ['name empty', { name: '' }, 'name'],
    ['name of 101 chars', { name: 'n'.repeat(101) }, 'name'],
    ['name with a NUL character', { name: 'Ini\u0000tech' }, 'name'],
    ['slug of 2 chars', { slug: 'ab' }, 'slug'],
    ['slug with capitals', { slug: 'Initech' }, 'slug'],
    ['currency not ISO 4217', { currency: 'eur' }, 'currency'],
    ['tax above 5000', { taxRateBps: 5001 }, 'taxRateBps'],
    ['tax negative', { taxRateBps: -1 }, 'taxRateBps'],
  ])('400 for %s', async (_name, overrides, path) => {
    const user = await userFactory.create();
    const res = await api
      .http()
      .post(`${V1}/workspaces`)
      .set(asUser(user.id))
      .send(valid(overrides))
      .expect(400);
    expect(
      (res.body as { details: { fields: { path: string }[] } }).details.fields.map((f) => f.path),
    ).toContain(path);
  });
});

describe('members (WS-003, WS-004)', () => {
  it('adds a registered user: 201 { id }; a second time → 409 ALREADY_MEMBER', async () => {
    const { as, workspaceId } = await ownerOfNewWorkspace();
    const colleague = await userFactory.create();

    const res = await api
      .http()
      .post(`${workspacePath(workspaceId)}/members`)
      .set(as)
      .send({ email: colleague.email, role: 'MEMBER' })
      .expect(201);
    expect(res.body).toEqual({ id: expect.any(String) });

    const again = await api
      .http()
      .post(`${workspacePath(workspaceId)}/members`)
      .set(as)
      .send({ email: colleague.email, role: 'VIEWER' })
      .expect(409);
    expect(again.body).toMatchObject({ code: 'ALREADY_MEMBER' });
  });

  it('404 USER_NOT_FOUND for an email nobody registered', async () => {
    const { as, workspaceId } = await ownerOfNewWorkspace();

    const res = await api
      .http()
      .post(`${workspacePath(workspaceId)}/members`)
      .set(as)
      .send({ email: 'ghost@example.test', role: 'MEMBER' })
      .expect(404);
    expect(res.body).toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('lists members with userId, email and role, cursor-paginated', async () => {
    const { owner, as, workspaceId } = await ownerOfNewWorkspace();
    const others = await userFactory.createList(2);
    for (const user of others) {
      await api
        .http()
        .post(`${workspacePath(workspaceId)}/members`)
        .set(as)
        .send({ email: user.email, role: 'VIEWER' })
        .expect(201);
    }

    const first = await api
      .http()
      .get(`${workspacePath(workspaceId)}/members`)
      .query({ limit: 2 })
      .set(as)
      .expect(200);
    const firstPage = first.body as { items: { userId: string }[]; nextCursor: string };
    const second = await api
      .http()
      .get(`${workspacePath(workspaceId)}/members`)
      .query({ limit: 2, cursor: firstPage.nextCursor })
      .set(as)
      .expect(200);
    const secondPage = second.body as { items: { userId: string }[]; nextCursor: string | null };

    const all = [...firstPage.items, ...secondPage.items];
    expect(secondPage.nextCursor).toBeNull();
    expect(all.map((m) => m.userId).sort()).toEqual([owner.id, ...others.map((u) => u.id)].sort());
    expect(all.find((m) => m.userId === owner.id)).toEqual({
      id: expect.any(String),
      userId: owner.id,
      email: owner.email,
      role: 'OWNER',
      createdAt: expect.any(String),
    });
  });
});

describe('query count (N+1 guard)', () => {
  it('lists 1 and 20 workspaces of a user with the same number of queries (WS-004, TEN-008)', async () => {
    const one = await userFactory.create();
    const twenty = await userFactory.create();
    for (const [user, count] of [
      [one, 1],
      [twenty, 20],
    ] as const) {
      for (const workspace of await workspaceFactory.createList(count)) {
        await membershipFactory.create({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'VIEWER',
        });
      }
    }
    const list = (userId: string) =>
      api.http().get(`${V1}/workspaces`).query({ limit: 20 }).set(asUser(userId)).expect(200);

    const forOne = await api.countQueries(() => list(one.id));
    const forTwenty = await api.countQueries(() => list(twenty.id));

    expect(forOne).toBeGreaterThan(0);
    expect(forTwenty).toBe(forOne);
    expect(forTwenty).toBeLessThanOrEqual(3);
  });

  it('lists 1 and 20 members with the same number of queries (WS-004)', async () => {
    const small = await ownerOfNewWorkspace();
    const large = await ownerOfNewWorkspace();
    for (const user of await userFactory.createList(19)) {
      await membershipFactory.create({
        workspaceId: large.workspaceId,
        userId: user.id,
        role: 'VIEWER',
      });
    }
    const members = (t: { as: { Authorization: string }; workspaceId: string }) =>
      api
        .http()
        .get(`${workspacePath(t.workspaceId)}/members`)
        .query({ limit: 20 })
        .set(t.as)
        .expect(200);

    const forOne = await api.countQueries(() => members(small));
    const forTwenty = await api.countQueries(() => members(large));

    expect(forOne).toBeGreaterThan(0);
    expect(forTwenty).toBe(forOne);
    expect(forTwenty).toBeLessThanOrEqual(3);
  });
});
