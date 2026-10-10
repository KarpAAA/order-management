// A slice of the app for int tests: config, the logger, database, CLS + transactions —
// exactly as shared.module.ts wires them — plus whatever the test is about. No HTTP, queues
// or JWT. The log goes nowhere.
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsPluginTransactional, TransactionHost } from '@nestjs-cls/transactional';
import { ClsModule, ClsService } from 'nestjs-cls';

import { TenantContext } from '@common/tenancy/tenant-context';
import { ConfigModule } from '@config/config.module';
import { DatabaseModule } from '@infra/database/database.module';
import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { createTransactionalAdapter } from '@infra/database/transactional.adapter';
import { LOG_DESTINATION, LoggerModule } from '@infra/logger/logger.module';
import type { WorkspaceMembership } from '@shared/auth/workspace-role';

import type { DynamicModule, Provider, Type } from '@nestjs/common';

export interface IntModule {
  get<T>(token: Type<T> | string | symbol): T;
  /** Repository-level work: the tenant bound like a job does it, inside one transaction. */
  inWorkspaceTx<T>(workspaceId: string, work: () => Promise<T>): Promise<T>;
  /** Use-case-level work: the membership bound like WorkspaceAccessGuard does it. */
  asMember<T>(membership: WorkspaceMembership, work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createIntModule(opts: {
  imports?: (Type | DynamicModule)[];
  providers: Provider[];
}): Promise<IntModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule, // DATABASE_URL of this file's database, set by test/setup/db.ts
      DatabaseModule,
      LoggerModule,
      ClsModule.forRoot({
        global: true,
        plugins: [
          new ClsPluginTransactional({
            imports: [DatabaseModule],
            adapter: createTransactionalAdapter(), // the production adapter
          }),
        ],
      }),
      ...(opts.imports ?? []),
    ],
    providers: opts.providers,
  })
    .overrideProvider(LOG_DESTINATION)
    .useValue({ write: () => undefined })
    .setLogger(new ConsoleLogger({ logLevels: ['fatal', 'error', 'warn'] })) // no query debug spam
    .compile();
  await moduleRef.init();

  const tenant = moduleRef.get(TenantContext);
  const cls = moduleRef.get(ClsService);
  const txHost = moduleRef.get<TransactionHost<DbTransactionAdapter>>(TransactionHost);

  return {
    get: (token) => moduleRef.get(token),
    inWorkspaceTx: (workspaceId, work) =>
      tenant.runInWorkspace(workspaceId, () => txHost.withTransaction(work)),
    asMember: (membership, work) =>
      cls.run(() => {
        tenant.enter(membership);
        return work();
      }),
    close: () => moduleRef.close(),
  };
}
