import {
  TenantContextMissingError,
  TenantMismatchError,
} from '@shared/errors/tenant-context-missing.error';

import { Prisma, type PrismaClient } from './generated/prisma/client';

/**
 * THE tenant choke point (docs/adr/0002-composite-tenant-keys.md).
 *
 * Every query on a tenant-scoped model gets `workspace_id = <tenant from context>` added to
 * its filter, and every write is checked to carry that same workspace. No tenant in context
 * → the query never runs. Step 2 replaces the body of this file with `SET LOCAL` + RLS;
 * nothing outside `infrastructure/database/` changes.
 *
 * Not covered, by design of Prisma extensions: `$queryRaw`, and nested reads/writes that
 * enter a tenant model through a relation of a global model (`workspace.create({ memberships })`).
 * Both are allowed only in the places documented in docs/architecture.md → "Tenancy".
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
  Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          const workspaceId = tenant.workspaceId();
          if (!workspaceId) throw new TenantContextMissingError(model, operation);
          return query(scopeArgs(args, workspaceId, model, operation));
        },
      },
    },
  });

export const createScopedClient = (prisma: PrismaClient, tenant: TenantSource) =>
  prisma.$extends(tenantScope(tenant));
