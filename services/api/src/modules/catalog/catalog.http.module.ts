// transport · http
import { Module } from '@nestjs/common';

import { IdentityModule } from '@modules/identity';

import { CatalogController } from './catalog.controller';
import { CatalogModule } from './catalog.module';

@Module({
  // IdentityModule provides MEMBERSHIP_READER to the workspace access guard
  imports: [CatalogModule, IdentityModule],
  controllers: [CatalogController],
})
export class CatalogHttpModule {}
