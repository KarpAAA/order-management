import { Global, Module } from '@nestjs/common';

import { TenantContext } from '@common/tenancy/tenant-context';

import { SCOPED_PRISMA } from './database.tokens';
import { PrismaService } from './prisma.service';
import { createScopedClient } from './tenant-scope.extension';

@Global()
@Module({
  providers: [
    PrismaService,
    TenantContext,
    {
      provide: SCOPED_PRISMA,
      useFactory: (prisma: PrismaService, tenant: TenantContext) =>
        createScopedClient(prisma, tenant),
      inject: [PrismaService, TenantContext],
    },
  ],
  exports: [PrismaService, TenantContext, SCOPED_PRISMA],
})
export class DatabaseModule {}
