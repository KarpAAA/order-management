// Every route of the API, described once. access-matrix.e2e-spec.ts turns each row into the
// 401 / 404 / 403 / "allowed" cases, and fails when the app has a route this table lacks —
// a new endpoint is protected by adding one row here.
import type { WorkspaceRole } from '@infra/database/generated/prisma/client';

import { orderFactory, productFactory, userFactory } from '../factories';
import {
  orderPath,
  ordersPath,
  productPath,
  productsPath,
  V1,
  workspacePath,
} from '../helpers/paths';
import { PRODUCT_ACME_ACTIVE } from '../seed/ids';
import { testDb } from '../setup/db';

/** Resources a case works on; filled by `arrange`, or placeholders when the guard stops first. */
export interface Ids {
  orderId: string;
  productId: string;
  email: string;
}

export interface RouteCase {
  /** `METHOD /v1/...` exactly as Express registers it — matched against the app's routes. */
  route: string;
  /** Distinguishes two rows of one route (e.g. adding a MEMBER vs an ADMIN). */
  variant?: string;
  method: 'get' | 'post' | 'patch';
  path: (workspaceId: string, ids: Ids) => string;
  scope: 'public' | 'user' | 'workspace';
  /** Roles the PERM table allows. Absent on a workspace route: a read, open to every member. */
  allowed?: readonly WorkspaceRole[];
  /** A FRESH resource in the state the action needs: allowed roles really change data. */
  arrange?: (workspaceId: string) => Promise<Partial<Ids>>;
  /** A minimal valid body, so a 403 is not pre-empted by a 400. */
  body?: (ids: Ids) => object;
  /** What a refused write must leave untouched (PERM-003). */
  state?: (workspaceId: string, ids: Ids) => Promise<unknown>;
  /** The route addresses one resource by id → the TEN-003 case (another tenant's id). */
  foreign?: 'order' | 'product';
}

export const ALL_ROLES: readonly WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
const WRITERS: readonly WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER'];
const MANAGERS: readonly WorkspaceRole[] = ['OWNER', 'ADMIN'];

/** Never exists: routes stopped by a guard still need a well-formed id in the path. */
export const PLACEHOLDER: Ids = {
  orderId: '01990000-0000-7000-8000-eeeeeeeeeeee',
  productId: '01990000-0000-7000-8000-eeeeeeeeeeef',
  email: 'placeholder@example.test',
};

const draftOrder = async (workspaceId: string) => ({
  orderId: (await orderFactory.create({ workspaceId })).id,
});
const paidOrder = async (workspaceId: string) => ({
  orderId: (await orderFactory.create({ workspaceId, status: 'PAID' })).id,
});
const product = async (workspaceId: string) => ({
  productId: (await productFactory.create({ workspaceId })).id,
});
const outsider = async () => ({ email: (await userFactory.create()).email });

const orderState = async (_ws: string, { orderId }: Ids) => {
  const row = await testDb().order.findFirstOrThrow({ where: { id: orderId } });
  const events = await testDb().orderEvent.count({ where: { orderId } });
  return { status: row.status, version: row.version, items: row.subtotalMinor, events };
};
const productState = ({ productId }: Ids) =>
  testDb().product.findFirstOrThrow({ where: { id: productId } });
const orderCount = (workspaceId: string) => testDb().order.count({ where: { workspaceId } });
const productCount = (workspaceId: string) => testDb().product.count({ where: { workspaceId } });
const memberCount = (workspaceId: string) => testDb().membership.count({ where: { workspaceId } });

let skus = 0;

export const ROUTES: readonly RouteCase[] = [
  // ── public ─────────────────────────────────────────────────────────────────
  {
    route: 'POST /v1/auth/register',
    method: 'post',
    scope: 'public',
    path: () => `${V1}/auth/register`,
  },
  { route: 'POST /v1/auth/login', method: 'post', scope: 'public', path: () => `${V1}/auth/login` },

  // ── any signed-in user ─────────────────────────────────────────────────────
  { route: 'GET /v1/me', method: 'get', scope: 'user', path: () => `${V1}/me` },
  { route: 'GET /v1/workspaces', method: 'get', scope: 'user', path: () => `${V1}/workspaces` },
  { route: 'POST /v1/workspaces', method: 'post', scope: 'user', path: () => `${V1}/workspaces` },

  // ── workspace and members ──────────────────────────────────────────────────
  {
    route: 'GET /v1/workspaces/:workspaceId',
    method: 'get',
    scope: 'workspace',
    path: (ws) => workspacePath(ws),
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/members',
    method: 'get',
    scope: 'workspace',
    path: (ws) => `${workspacePath(ws)}/members`,
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/members',
    variant: 'granting MEMBER',
    method: 'post',
    scope: 'workspace',
    path: (ws) => `${workspacePath(ws)}/members`,
    allowed: MANAGERS,
    arrange: outsider,
    body: ({ email }) => ({ email, role: 'MEMBER' }),
    state: memberCount,
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/members',
    variant: 'granting ADMIN',
    method: 'post',
    scope: 'workspace',
    path: (ws) => `${workspacePath(ws)}/members`,
    allowed: ['OWNER'],
    arrange: outsider,
    body: ({ email }) => ({ email, role: 'ADMIN' }),
    state: memberCount,
  },

  // ── catalog ────────────────────────────────────────────────────────────────
  {
    route: 'GET /v1/workspaces/:workspaceId/products',
    method: 'get',
    scope: 'workspace',
    path: (ws) => productsPath(ws),
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/products',
    method: 'post',
    scope: 'workspace',
    path: (ws) => productsPath(ws),
    allowed: MANAGERS,
    body: () => ({ sku: `MATRIX-${String((skus += 1))}`, name: 'Matrix product', priceMinor: 100 }),
    state: productCount,
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/products/:productId',
    method: 'get',
    scope: 'workspace',
    path: (ws, { productId }) => productPath(ws, productId),
    arrange: product,
    foreign: 'product',
  },
  {
    route: 'PATCH /v1/workspaces/:workspaceId/products/:productId',
    method: 'patch',
    scope: 'workspace',
    path: (ws, { productId }) => productPath(ws, productId),
    allowed: MANAGERS,
    arrange: product,
    body: () => ({ name: 'Renamed by the matrix' }),
    state: (_ws, ids) => productState(ids),
    foreign: 'product',
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/products/:productId/archive',
    method: 'post',
    scope: 'workspace',
    path: (ws, { productId }) => `${productPath(ws, productId)}/archive`,
    allowed: MANAGERS,
    arrange: product,
    state: (_ws, ids) => productState(ids),
    foreign: 'product',
  },

  // ── orders ─────────────────────────────────────────────────────────────────
  {
    route: 'GET /v1/workspaces/:workspaceId/orders',
    method: 'get',
    scope: 'workspace',
    path: (ws) => ordersPath(ws),
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/orders',
    method: 'post',
    scope: 'workspace',
    path: (ws) => ordersPath(ws),
    allowed: WRITERS,
    body: () => ({ items: [{ productId: PRODUCT_ACME_ACTIVE, quantity: 1 }] }),
    state: orderCount,
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/orders/:orderId',
    method: 'get',
    scope: 'workspace',
    path: (ws, { orderId }) => orderPath(ws, orderId),
    arrange: draftOrder,
    foreign: 'order',
  },
  {
    route: 'PATCH /v1/workspaces/:workspaceId/orders/:orderId',
    method: 'patch',
    scope: 'workspace',
    path: (ws, { orderId }) => orderPath(ws, orderId),
    allowed: WRITERS,
    arrange: draftOrder,
    body: () => ({ version: 0, items: [], discount: { type: 'NONE' } }),
    state: orderState,
    foreign: 'order',
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/orders/:orderId/place',
    method: 'post',
    scope: 'workspace',
    path: (ws, { orderId }) => `${orderPath(ws, orderId)}/place`,
    allowed: WRITERS,
    arrange: draftOrder,
    body: () => ({ version: 0 }),
    state: orderState,
    foreign: 'order',
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/orders/:orderId/cancel',
    method: 'post',
    scope: 'workspace',
    path: (ws, { orderId }) => `${orderPath(ws, orderId)}/cancel`,
    allowed: WRITERS,
    arrange: draftOrder,
    body: () => ({ version: 0 }),
    state: orderState,
    foreign: 'order',
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/orders/:orderId/fulfill',
    method: 'post',
    scope: 'workspace',
    path: (ws, { orderId }) => `${orderPath(ws, orderId)}/fulfill`,
    allowed: MANAGERS,
    arrange: paidOrder,
    body: () => ({ version: 0 }),
    state: orderState,
    foreign: 'order',
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/orders/:orderId/events',
    method: 'get',
    scope: 'workspace',
    path: (ws, { orderId }) => `${orderPath(ws, orderId)}/events`,
    arrange: draftOrder,
    foreign: 'order',
  },
];

export const label = (r: RouteCase): string => (r.variant ? `${r.route} (${r.variant})` : r.route);
