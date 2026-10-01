import {
  TenantContextMissingError,
  TenantMismatchError,
} from '@shared/errors/tenant-context-missing.error';

import { Prisma, type PrismaClient } from './generated/prisma/client';

/**
 * THE tenant choke point (docs/adr/0002-composite-tenant-keys.md, 0006-row-level-security.md).
 *
 * Two layers on every query on a tenant-scoped model:
 *  1. here: `workspace_id = <tenant from context>` is added to the filter and every write is
 *     checked to carry that same workspace. No tenant in context → the query never runs.
 *  2. in Postgres: Row-Level Security compares `workspace_id` with `app.workspace_id`, which
 *     must be set in the transaction of the query. Inside `@Transactional()` the adapter set it
 *     when the transaction began (transactional.adapter.ts); outside one, the query is wrapped
 *     in its own transaction here. The setting is transaction-local on purpose: a pooled
 *     connection never carries a tenant over to the next query.
 *
 * Not covered by layer 1, by design of Prisma extensions: `$queryRaw`, and nested reads/writes
 * that enter a tenant model through a relation of a global model
 * (`workspace.create({ memberships })`). Layer 2 covers both.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'Membership',
  'Product',
  'Order',
  'OrderItem',
  'OrderEvent',
]);

type Args = Record<string, unknown>;

export interface TenantSource {
  workspaceId(): string | undefined;
}

/**
 * Whether Prisma runs this very operation inside a transaction (the `tx` of `@Transactional()`,
 * or a `$transaction([...])` batch). Asked per operation, not per request: the root client
 * used while a transaction is open (a query service called from a use case) is NOT in it.
 * `__internalParams` is not public API; test/tenancy/tenant-scope.int-spec.ts fails if a
 * Prisma upgrade drops it.
 */
function runsInTransaction(params: object): boolean {
  const internal = (params as { __internalParams?: { transaction?: unknown } }).__internalParams;
  return internal?.transaction !== undefined;
}

const isRecord = (value: unknown): value is Args =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertSameWorkspace(value: Args, workspaceId: string, model: string, op: string): void {
  if ('workspaceId' in value && value.workspaceId !== workspaceId) {
    throw new TenantMismatchError(model, op);
  }
  // composite unique inputs: `workspaceId_id`, `workspaceId_userId`, `workspaceId_sku`, …
  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith('workspaceId_') && isRecord(nested)) {
      assertSameWorkspace(nested, workspaceId, model, op);
    }
  }
}

function scopeWhere(args: Args, workspaceId: string, model: string, op: string): Args {
  const where = isRecord(args.where) ? args.where : {};
  assertSameWorkspace(where, workspaceId, model, op);
  return { ...args, where: { ...where, workspaceId } };
}

function scopeData(data: unknown, workspaceId: string, model: string, op: string): unknown {
  if (Array.isArray(data)) return data.map((row) => scopeData(row, workspaceId, model, op));
  if (!isRecord(data)) return data;
  assertSameWorkspace(data, workspaceId, model, op);
  // A checked input connects the workspace through the relation instead of the scalar.
  return 'workspace' in data ? data : { ...data, workspaceId };
}

function scopeArgs(args: Args, workspaceId: string, model: string, op: string): Args {
  switch (op) {
    case 'create':
    case 'createMany':
    case 'createManyAndReturn':
      return { ...args, data: scopeData(args.data, workspaceId, model, op) };
    case 'upsert':
      return {
        ...scopeWhere(args, workspaceId, model, op),
        create: scopeData(args.create, workspaceId, model, op),
        update: guardUpdate(args.update, workspaceId, model, op),
      };
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      return {
        ...scopeWhere(args, workspaceId, model, op),
        data: guardUpdate(args.data, workspaceId, model, op),
      };
    default:
      // find*, count, aggregate, groupBy, delete, deleteMany
      return scopeWhere(args, workspaceId, model, op);
  }
}

function guardUpdate(data: unknown, workspaceId: string, model: string, op: string): unknown {
  if (isRecord(data)) assertSameWorkspace(data, workspaceId, model, op);
  return data;
}

export const tenantScope = (tenant: TenantSource) =>
  Prisma.defineExtension((client) =>
    client.$extends({
      name: 'tenant-scope',
      query: {
        $allModels: {
          async $allOperations(params) {
            const { model, operation, args, query } = params;
            if (!TENANT_MODELS.has(model)) return query(args);
            const workspaceId = tenant.workspaceId();
            if (!workspaceId) throw new TenantContextMissingError(model, operation);
            const scoped = scopeArgs(args, workspaceId, model, operation);
            // Already in a transaction: its first statement set the tenant, and one of our
            // own here would run on another connection.
            if (runsInTransaction(params)) return query(scoped);
            const [, result] = await client.$transaction([
              client.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`,
              query(scoped),
            ]);
            return result;
          },
        },
      },
    }),
  );

export const createScopedClient = (prisma: PrismaClient, tenant: TenantSource) =>
  prisma.$extends(tenantScope(tenant));
