import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';

import { SCOPED_PRISMA } from './database.tokens';

import type { DbTransactionAdapter, ScopedPrismaClient } from './database.tokens';

/**
 * `@Transactional()` runs on the tenant-scoped client, so queries inside a transaction are
 * scoped exactly like queries outside one.
 */
export const createTransactionalAdapter = (): DbTransactionAdapter =>
  // The only cast in the setup: see DbTransactionAdapter for why the types disagree.
  new TransactionalAdapterPrisma<ScopedPrismaClient>({
    prismaInjectionToken: SCOPED_PRISMA,
  }) as unknown as DbTransactionAdapter;
