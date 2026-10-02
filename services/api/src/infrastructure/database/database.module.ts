import { Global, Module } from '@nestjs/common';

import { TenantContext } from '@common/tenancy/tenant-context';

import { READ_DB, SCOPED_PRISMA, type ScopedPrismaClient } from './database.tokens';
import { PrismaService } from './prisma.service';
import { createReadDb, ReadSource } from './read-source';
import { ReplicaPrismaService } from './replica-prisma.service';
import { createScopedClient } from './tenant-scope.extension';

@Global()
@Module({
  providers: [
    PrismaService,
    ReplicaPrismaService,
    TenantContext,
    ReadSource,
    {
      provide: SCOPED_PRISMA,
      useFactory: (prisma: PrismaService, tenant: TenantContext) =>
        createScopedClient(prisma, tenant),
      inject: [PrismaService, TenantContext],
    },
    {
      provide: READ_DB,
      // the replica gets the same tenant scope and the same Row-Level Security frame
      useFactory: (
        primary: ScopedPrismaClient,
        replica: ReplicaPrismaService,
        tenant: TenantContext,
        source: ReadSource,
      ) =>
        replica.enabled
          ? createReadDb(primary, createScopedClient(replica.client, tenant), source)
          : primary,
      inject: [SCOPED_PRISMA, ReplicaPrismaService, TenantContext, ReadSource],
    },
  ],
  exports: [PrismaService, ReplicaPrismaService, TenantContext, ReadSource, SCOPED_PRISMA, READ_DB],
})
export class DatabaseModule {}
