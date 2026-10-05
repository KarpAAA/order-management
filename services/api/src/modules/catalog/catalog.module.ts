// layered · L1 · CQS
import { Module } from '@nestjs/common';

import { cacheConfig, type CacheConfig } from '@config/configuration';
import { RedisCacheModule } from '@infra/cache/redis-cache.module';

import { IdentityModule } from '@modules/identity';

import { CATALOG_CACHE_TTL_SECONDS } from './catalog-cache';
import { CatalogFacade } from './catalog.facade';
import { CatalogPolicy } from './catalog.policy';
import { CatalogService } from './catalog.service';
import { CatalogQueryService } from './read/catalog.query.service';

@Module({
  imports: [IdentityModule, RedisCacheModule],
  providers: [
    // write
    CatalogService,
    CatalogPolicy,
    // read
    CatalogQueryService,
    {
      provide: CATALOG_CACHE_TTL_SECONDS,
      useFactory: (config: CacheConfig) => config.catalogTtlSeconds,
      inject: [cacheConfig.KEY],
    },
    // facade
    CatalogFacade,
  ],
  // CatalogService/QueryService are exported to catalog's own transport module only.
  exports: [CatalogFacade, CatalogService, CatalogQueryService],
})
export class CatalogModule {}
