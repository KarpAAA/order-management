// Endpoint × kind of stranger (TEN-001…004, TEN-007, TEN-008, PERM-001…003, AUTH-006).
// Every case is generated from ROUTES in access-matrix.ts. The layers, in Nest's order:
//   AuthGuard 401 → WorkspaceAccessGuard 404 → ValidationPipe 400 → getById 404 → policy 403
// so 401/404-A need no body, while 403 needs a valid body and an existing resource.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkspaceRole } from '@infra/database/generated/prisma/client';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { orderPath, ordersPath, productsPath, V1, workspacePath } from '../helpers/paths';
import {
  PRODUCT_GLOBEX_ACTIVE,
  USER_ACME_ADMIN,
  USER_ACME_MEMBER,
  USER_ACME_OWNER,
  USER_ACME_VIEWER,
  USER_BOTH,
  USER_GLOBEX_ADMIN,
  USER_GLOBEX_MEMBER,
  USER_GLOBEX_OWNER,
  USER_GLOBEX_VIEWER,
  WS_ACME,
  WS_GLOBEX,
} from '../seed/ids';
import { testDb } from '../setup/db';

import { ALL_ROLES, label, PLACEHOLDER, ROUTES, type Ids, type RouteCase } from './access-matrix';

let api: ApiApp;
let globexOrderId: string;

beforeAll(async () => {
  api = await createApiApp();
  globexOrderId = (await orderFactory.create({ workspaceId: WS_GLOBEX })).id;
});
afterAll(() => api.close());

const ACME_USER_BY_ROLE: Record<WorkspaceRole, string> = {
  OWNER: USER_ACME_OWNER,
  ADMIN: USER_ACME_ADMIN,
  MEMBER: USER_ACME_MEMBER,
  VIEWER: USER_ACME_VIEWER,
};

function send(r: RouteCase, workspaceId: string, ids: Ids, headers?: { Authorization: string }) {
  const req = api.http()[r.method](r.path(workspaceId, ids));
  if (headers) void req.set(headers);
  return req.send(r.body?.(ids) ?? {});
}

async function arrange(r: RouteCase, workspaceId = WS_ACME): Promise<Ids> {
  return { ...PLACEHOLDER, ...(await r.arrange?.(workspaceId)) };
}

const guarded = ROUTES.filter((r) => r.scope !== 'public');
const inWorkspace = ROUTES.filter((r) => r.scope === 'workspace');
const addressed = inWorkspace.filter((r) => r.foreign);
const denied = inWorkspace.flatMap((r) =>
  r.allowed
    ? ALL_ROLES.filter((role) => !r.allowed?.includes(role)).map((role) => ({ r, role }))
    : [],
);
const permitted = inWorkspace.flatMap((r) => (r.allowed ?? ALL_ROLES).map((role) => ({ r, role })));

describe('the matrix covers the whole API', () => {
  it('has a row for every registered route, and no row for a route that does not exist', () => {
    const registered = new Set(api.routes());
    const described = new Set(ROUTES.map((r) => r.route));

    expect([...registered].filter((route) => !described.has(route))).toEqual([]);
    expect([...described].filter((route) => !registered.has(route))).toEqual([]);
  });
});

describe('401: no token (AUTH-006)', () => {
  it.each(guarded.map((r) => [label(r), r] as const))('%s', async (_name, r) => {
    const res = await send(r, WS_ACME, PLACEHOLDER).expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('404 WORKSPACE_NOT_FOUND: not a member of the workspace in the URL (TEN-001, TEN-002)', () => {
  const strangers = [
    ['a member of another workspace', WS_ACME, USER_GLOBEX_OWNER],
    ['a workspace that does not exist', '01990000-0000-7000-8000-000000000bad', USER_ACME_OWNER],
    ['a workspace id that is not a UUID', 'not-a-uuid', USER_ACME_OWNER],
  ] as const;

  it.each(
    inWorkspace.flatMap((r) =>
      strangers.map(
        ([who, workspaceId, userId]) => [label(r), who, { r, workspaceId, userId }] as const,
      ),
    ),
  )('%s — %s', async (_name, _who, { r, workspaceId, userId }) => {
    const res = await send(r, workspaceId, PLACEHOLDER, asUser(userId)).expect(404);
    expect(res.body).toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });
});

describe("404: another tenant's resource under my workspace (TEN-003)", () => {
  it.each(addressed.map((r) => [label(r), r] as const))('%s', async (_name, r) => {
    const foreign: Ids = {
      ...PLACEHOLDER,
      orderId: globexOrderId,
      productId: PRODUCT_GLOBEX_ACTIVE,
    };
    const before = await r.state?.(WS_GLOBEX, foreign);

    // the acme OWNER may do anything in acme — only the tenant filter can stop this
    const res = await send(r, WS_ACME, foreign, asUser(USER_ACME_OWNER)).expect(404);

    expect(res.body).toMatchObject({
      code: r.foreign === 'order' ? 'ORDER_NOT_FOUND' : 'PRODUCT_NOT_FOUND',
    });
    if (r.state) expect(await r.state(WS_GLOBEX, foreign)).toEqual(before);
  });
});

describe('403 FORBIDDEN: a member whose role is not enough, and nothing changes (PERM-001, PERM-003)', () => {
  it.each(denied.map(({ r, role }) => [label(r), role, r] as const))(
    '%s — %s',
    async (_name, role, r) => {
      const ids = await arrange(r);
      const before = await r.state?.(WS_ACME, ids);

      const res = await send(r, WS_ACME, ids, asUser(ACME_USER_BY_ROLE[role])).expect(403);

      expect(res.body).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
      expect(await r.state?.(WS_ACME, ids)).toEqual(before);
    },
  );
});

describe('allowed roles are not refused (fresh resource each time)', () => {
  it.each(permitted.map(({ r, role }) => [label(r), role, r] as const))(
    '%s — %s',
    async (_name, role, r) => {
      const ids = await arrange(r);

      const res = await send(r, WS_ACME, ids, asUser(ACME_USER_BY_ROLE[role]));

      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(400);
    },
  );
});

describe('the permission check comes before the state check (PERM-002)', () => {
  it('a VIEWER cancelling a PAID order gets 403, not 422', async () => {
    const { id } = await orderFactory.create({ status: 'PAID' });

    const res = await api
      .http()
      .post(`${orderPath(WS_ACME, id)}/cancel`)
      .set(asUser(USER_ACME_VIEWER))
      .send({ version: 0 })
      .expect(403);
    expect(res.body).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
  });
});

describe("lists never contain another workspace's rows (TEN-004)", () => {
  const owner = asUser(USER_ACME_OWNER);

  it('products', async () => {
    const { body } = await api
      .http()
      .get(productsPath(WS_ACME))
      .query({ limit: 100 })
      .set(owner)
      .expect(200);
    const ids = (body as { items: { id: string }[] }).items.map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(PRODUCT_GLOBEX_ACTIVE);
  });

  it('orders', async () => {
    await orderFactory.create(); // at least one acme order
    const { body } = await api
      .http()
      .get(ordersPath(WS_ACME))
      .query({ limit: 100 })
      .set(owner)
      .expect(200);
    const ids = (body as { items: { id: string }[] }).items.map((o) => o.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(globexOrderId);
    const globexIds = (await testDb().order.findMany({ where: { workspaceId: WS_GLOBEX } })).map(
      (o) => o.id,
    );
    expect(ids.filter((id) => globexIds.includes(id))).toEqual([]);
  });

  it('members', async () => {
    const { body } = await api
      .http()
      .get(`${workspacePath(WS_ACME)}/members`)
      .query({ limit: 100 })
      .set(owner)
      .expect(200);
    const userIds = (body as { items: { userId: string }[] }).items.map((m) => m.userId);
    expect(userIds).toContain(USER_BOTH);
    for (const globexOnly of [
      USER_GLOBEX_OWNER,
      USER_GLOBEX_ADMIN,
      USER_GLOBEX_MEMBER,
      USER_GLOBEX_VIEWER,
    ]) {
      expect(userIds).not.toContain(globexOnly);
    }
  });

  it('order events', async () => {
    const { id } = await orderFactory.create({ status: 'PAID' });
    const { body } = await api
      .http()
      .get(`${orderPath(WS_ACME, id)}/events`)
      .set(owner)
      .expect(200);
    const events = (body as { items: { id: string }[] }).items;
    const own = await testDb().orderEvent.findMany({ where: { orderId: id } });
    expect(events.map((e) => e.id).sort()).toEqual(own.map((e) => e.id).sort());
  });
});

describe('roles are per workspace (TEN-007, TEN-008)', () => {
  const both = asUser(USER_BOTH);

  it('the same user may cancel in acme (MEMBER) and may not in globex (VIEWER)', async () => {
    const inAcme = await orderFactory.create({ workspaceId: WS_ACME });
    const inGlobex = await orderFactory.create({ workspaceId: WS_GLOBEX });

    await api
      .http()
      .post(`${orderPath(WS_ACME, inAcme.id)}/cancel`)
      .set(both)
      .send({ version: 0 })
      .expect(204);
    await api
      .http()
      .post(`${orderPath(WS_GLOBEX, inGlobex.id)}/cancel`)
      .set(both)
      .send({ version: 0 })
      .expect(403);
  });

  it('GET /workspaces/{id} reports the role in that workspace', async () => {
    const acme = await api.http().get(workspacePath(WS_ACME)).set(both).expect(200);
    const globex = await api.http().get(workspacePath(WS_GLOBEX)).set(both).expect(200);
    expect((acme.body as { myRole: string }).myRole).toBe('MEMBER');
    expect((globex.body as { myRole: string }).myRole).toBe('VIEWER');
  });

  it('GET /workspaces lists exactly my workspaces, each with my role', async () => {
    const { body } = await api.http().get(`${V1}/workspaces`).set(both).expect(200);
    const mine = (body as { items: { id: string; myRole: string }[] }).items
      .map(({ id, myRole }) => ({ id, myRole }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(mine).toEqual([
      { id: WS_ACME, myRole: 'MEMBER' },
      { id: WS_GLOBEX, myRole: 'VIEWER' },
    ]);
  });
});
