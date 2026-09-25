import { Injectable } from '@nestjs/common';

import { CatalogQueryService, type ProductSnapshot } from './read/catalog.query.service';

/** Public API of the catalog. */
@Injectable()
export class CatalogFacade {
  constructor(private readonly query: CatalogQueryService) {}

  /** Current state of the given products in the current workspace. Unknown ids are absent. */
  findProductSnapshots(productIds: readonly string[]): Promise<ProductSnapshot[]> {
    return this.query.findSnapshots(productIds);
  }
}
