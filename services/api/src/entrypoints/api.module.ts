import { Module } from '@nestjs/common';

import { SharedModule } from '@infra/shared.module';

import { CatalogHttpModule } from '@modules/catalog';
import { IdentityHttpModule } from '@modules/identity';
import { OrdersHttpModule } from '@modules/orders';

/** The HTTP process. Imports only (ops/process-model.md §2). */
@Module({
  imports: [SharedModule, IdentityHttpModule, CatalogHttpModule, OrdersHttpModule],
})
export class ApiModule {}
