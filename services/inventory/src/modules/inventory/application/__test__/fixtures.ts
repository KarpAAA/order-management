import { NoOpTransactionalAdapter, TransactionHost } from '@nestjs-cls/transactional';

import { systemActor } from '@shared/auth/actor';
import type { Clock } from '@shared/domain/clock';

import { LATER } from '../../domain/__test__/builders';

/** Stub: "now" is always LATER, so timestamps written by the use case are assertable. */
export const fixedClock: Clock = { now: () => LATER };

/** The only actor allowed to change the stock (`InventoryPolicy`). */
export const consumer = systemActor('consumer:inventory');
export const stranger = systemActor('consumer:orders');

export const CORRELATION_ID = '01990000-0000-7000-8000-c00000000001';

/** What the use case did to the outside, in order: the doubles of one test share it. */
export type Journal = string[];

/**
 * `@Transactional()` looks up a global `TransactionHost` and throws without one. Register one
 * backed by the library's no-op adapter: the method runs as is, no transaction, no database.
 */
export function enableNoOpTransactions(): void {
  const connection = {};
  const adapter = new NoOpTransactionalAdapter({ tx: connection, disableWarning: true });
  // What ClsPluginTransactional would pass for the default connection.
  new TransactionHost<NoOpTransactionalAdapter>({
    ...adapter.optionsFactory(connection),
    connectionName: undefined,
    enableTransactionProxy: false,
    defaultTxOptions: {},
    extraProviderTokens: [],
  });
}
