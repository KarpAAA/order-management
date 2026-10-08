import { PrismaService } from './prisma.service';

import type { Prisma } from './generated/prisma/client';
import type { TransactionalAdapter, TransactionHost } from '@nestjs-cls/transactional';

/** What a repository-like write sees: the transaction when one is open, the client otherwise. */
type Tx = Prisma.TransactionClient;

interface TxOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

export type DbTransactionAdapter = TransactionalAdapter<PrismaService, Tx, TxOptions>;

/** `txHost.tx` joins the transaction of `txHost.withTransaction()`; outside one it is the client. */
export type WriteDb = TransactionHost<DbTransactionAdapter>;

/**
 * The transaction of a use case, carried in CLS (`transactions: cls`): a write and the outbox
 * row that tells about it go through `txHost.tx` and commit together. Written by hand, as in
 * the api: the library's Prisma adapter does not type under `exactOptionalPropertyTypes`.
 * No tenant step here: the tenant is a column in this service, there is no Row-Level Security.
 */
export const createTransactionalAdapter = (): DbTransactionAdapter => ({
  connectionToken: PrismaService,
  optionsFactory: (prisma: PrismaService) => ({
    wrapWithTransaction: (options, fn, setTx) =>
      prisma.$transaction((tx) => {
        setTx(tx);
        return fn() as Promise<unknown>;
      }, options),
    getFallbackInstance: () => prisma,
  }),
});
