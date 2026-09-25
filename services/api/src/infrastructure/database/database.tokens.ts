import type { createScopedClient } from './tenant-scope.extension';
import type { TransactionalAdapter, TransactionHost } from '@nestjs-cls/transactional';
import type { PrismaTransactionalClient } from '@nestjs-cls/transactional-adapter-prisma';

/** The tenant-scoped Prisma client. */
export type ScopedPrismaClient = ReturnType<typeof createScopedClient>;

/**
 * Two handles from day one (data/db-general.md §8). Today both reach the same primary;
 * a read replica in Step 2 is a change in this folder only.
 *
 * - write: `TransactionHost<DbTransactionAdapter>` → `txHost.tx` joins the current
 *   `@Transactional()` (repositories and L1 services)
 * - read:  `READ_DB` → scoped client for query services, outside any transaction
 */
export const SCOPED_PRISMA = Symbol('SCOPED_PRISMA');
export const READ_DB = SCOPED_PRISMA;

export type ReadDb = ScopedPrismaClient;

/**
 * Structural twin of `TransactionalAdapterPrisma<ScopedPrismaClient>`. The library class
 * declares `defaultTxOptions` as possibly `undefined`, which `exactOptionalPropertyTypes`
 * rejects, so the host is typed through this shape instead (see transactional.adapter.ts).
 */
export type DbTransactionAdapter = TransactionalAdapter<
  ScopedPrismaClient,
  PrismaTransactionalClient<ScopedPrismaClient>,
  Record<string, unknown>
>;

export type WriteDb = TransactionHost<DbTransactionAdapter>;
