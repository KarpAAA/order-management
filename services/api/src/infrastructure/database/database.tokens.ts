import type { createScopedClient } from './tenant-scope.extension';
import type { TransactionalAdapter, TransactionHost } from '@nestjs-cls/transactional';
import type {
  PrismaTransactionalClient,
  PrismaTransactionOptions,
} from '@nestjs-cls/transactional-adapter-prisma';

/** The tenant-scoped Prisma client. */
export type ScopedPrismaClient = ReturnType<typeof createScopedClient>;

/**
 * Two handles from day one (data/db-general.md §8).
 *
 * - write: `TransactionHost<DbTransactionAdapter>` → `txHost.tx` joins the current
 *   `@Transactional()` (repositories and L1 services). Always the primary.
 * - read:  `READ_DB` → scoped client for query services, outside any transaction. The read
 *   replica for a GET request whose caller has no write the replica is still missing, the
 *   primary for everything else (read-source.ts, docs/adr/0009-read-replica-routing.md).
 *   With no replica configured it is `SCOPED_PRISMA` itself.
 */
export const SCOPED_PRISMA = Symbol('SCOPED_PRISMA');
export const READ_DB = Symbol('READ_DB');

export type ReadDb = ScopedPrismaClient;

/** The shape of the adapter in transactional.adapter.ts; `tx` is the scoped client's transaction. */
export type DbTransactionAdapter = TransactionalAdapter<
  ScopedPrismaClient,
  PrismaTransactionalClient<ScopedPrismaClient>,
  PrismaTransactionOptions<ScopedPrismaClient>
>;

export type WriteDb = TransactionHost<DbTransactionAdapter>;
