import { NoOpTransactionalAdapter, TransactionHost } from '@nestjs-cls/transactional';

import type { TenantContext } from '@common/tenancy/tenant-context';
import { systemActor, userActor } from '@shared/auth/actor';
import type { WorkspaceRole } from '@shared/auth/workspace-role';
import type { Clock } from '@shared/domain/clock';
import { InfrastructureError } from '@shared/errors/infrastructure-error';

import { LATER, USER, WORKSPACE } from '../../domain/__test__/builders';

/** Stub: "now" is always LATER, so timestamps written by the use case are assertable. */
export const fixedClock: Clock = { now: () => LATER };

/** Stub: the caller's membership in WORKSPACE with `role`; `null` for system work (jobs). */
export function tenantAs(role: WorkspaceRole | null): TenantContext {
  const membership = role && { workspaceId: WORKSPACE, userId: USER, role };
  return { membership: () => membership } as unknown as TenantContext;
}

export const member = userActor(USER);
/** The only actor allowed to settle payments (`OrdersPolicy.assertCanSettlePayment`). */
export const paymentConsumer = systemActor('consumer:orders');

/** A transport failure as a gateway adapter reports it. */
export class TestGatewayError extends InfrastructureError {
  readonly code = 'TEST_GATEWAY_ERROR';

  constructor(readonly retryable: boolean) {
    super(`gateway failed (retryable=${retryable})`);
  }
}

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
