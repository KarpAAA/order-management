import { NoOpTransactionalAdapter, TransactionHost } from '@nestjs-cls/transactional';

import { systemActor } from '@shared/auth/actor';
import type { Clock } from '@shared/domain/clock';

import { LATER } from '../../domain/__test__/builders';

/** Stub: "now" is always LATER, so timestamps written by the use case are assertable. */
export const fixedClock: Clock = { now: () => LATER };

/** The two actors `NotificationsPolicy` knows, and one it does not. */
export const consumer = systemActor('consumer:notifications');
export const dispatcher = systemActor('dispatcher:notifications');
export const stranger = systemActor('consumer:orders');

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
