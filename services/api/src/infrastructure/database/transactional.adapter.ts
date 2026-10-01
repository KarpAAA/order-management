import { TenantContext } from '@common/tenancy/tenant-context';

import { SCOPED_PRISMA } from './database.tokens';

import type { DbTransactionAdapter, ScopedPrismaClient } from './database.tokens';

/**
 * `@Transactional()` runs on the tenant-scoped client, and every transaction starts by telling
 * Postgres its tenant: `app.workspace_id`, transaction-local, is what the Row-Level Security
 * policies compare against (docs/adr/0006-row-level-security.md).
 *
 * The tenant must be bound before the transaction begins. One that is bound later is not
 * applied, and the database stays closed: no row is visible, every write is refused.
 *
 * Written by hand instead of `TransactionalAdapterPrisma`: the library has no hook at the
 * start of a transaction. Nested transactions (savepoints) are not supported, as before.
 */
export const createTransactionalAdapter = (): DbTransactionAdapter => ({
  connectionToken: SCOPED_PRISMA,
  extraProviderTokens: [TenantContext],
  optionsFactory: (prisma: ScopedPrismaClient, extraProviders: unknown[]) => {
    const [tenant] = extraProviders as [TenantContext];
    return {
      wrapWithTransaction: (options, fn, setTx) =>
        prisma.$transaction(async (tx) => {
          const workspaceId = tenant.workspaceId();
          if (workspaceId) {
            await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
          }
          setTx(tx);
          return fn() as Promise<unknown>;
        }, options),
      getFallbackInstance: () => prisma,
    };
  },
});
