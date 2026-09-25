// layered · L1 · CQS
import { Module } from '@nestjs/common';

import { IdentityModule } from '@modules/identity';

import { CatalogFacade } from './catalog.facade';
import { CatalogPolicy } from './catalog.policy';
import { CatalogService } from './catalog.service';
import { CatalogQueryService } from './read/catalog.query.service';

@Module({
  imports: [IdentityModule],
  providers: [
    // write
    CatalogService,
    CatalogPolicy,
    // read
    CatalogQueryService,
    // facade
    CatalogFacade,
  ],
  // CatalogService/QueryService are exported to catalog's own transport module only.
  exports: [CatalogFacade, CatalogService, CatalogQueryService],
})
export class CatalogModule {}
