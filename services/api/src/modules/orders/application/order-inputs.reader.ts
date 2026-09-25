import { Injectable } from '@nestjs/common';

import { CatalogFacade, type ProductSnapshot } from '@modules/catalog';
import { IdentityFacade, type WorkspaceTerms } from '@modules/identity';

import { OrderProductNotFoundError } from '../domain/errors';

import type { OrderLineInput } from '../domain/order';

export interface RequestedItem {
  productId: string;
  quantity: number;
}

/**
 * What an order needs from other modules, read through their facades before the
 * transaction opens: the workspace terms to snapshot, and catalog data for each line.
 * Whether a product may be ordered (ACTIVE) is decided by the domain from `isActive`.
 */
@Injectable()
export class OrderInputsReader {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly identity: IdentityFacade,
  ) {}

  workspaceTerms(workspaceId: string): Promise<WorkspaceTerms> {
    return this.identity.getWorkspaceTerms(workspaceId);
  }

  async lines(items: readonly RequestedItem[]): Promise<OrderLineInput[]> {
    if (items.length === 0) return [];
    const ids = [...new Set(items.map((item) => item.productId))];
    const snapshots = new Map<string, ProductSnapshot>(
      (await this.catalog.findProductSnapshots(ids)).map((product) => [product.id, product]),
    );
    return items.map((item) => {
      const product = snapshots.get(item.productId);
      if (!product) throw new OrderProductNotFoundError(item.productId);
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unitPriceMinor: product.priceMinor,
        isActive: product.isActive,
        quantity: item.quantity,
      };
    });
  }
}
