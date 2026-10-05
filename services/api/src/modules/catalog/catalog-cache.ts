import type { PaginatedByCursor } from '@shared/pagination/cursor';

import type { ProductDto } from './catalog.dto';
import type { ProductStatus } from './product-status';

/** Seconds a cached product or page lives; bound in catalog.module.ts from the configuration. */
export const CATALOG_CACHE_TTL_SECONDS = Symbol('CATALOG_CACHE_TTL_SECONDS');

/**
 * The cache keys of the catalog, built here and nowhere else. Redis knows neither the tenant
 * scope nor Row-Level Security: the workspace in the namespace is what keeps one tenant's
 * products out of another's answers (docs/adr/0010-catalog-cache.md).
 *
 * A cached product carries the workspace currency. A workspace cannot change it today; an
 * endpoint that does must invalidate this namespace.
 */
export const catalogNamespace = (workspaceId: string): string => `catalog:${workspaceId}`;

export const productKey = (productId: string): string => `product:${productId}`;

export const productListKey = (filter: {
  cursor?: string;
  limit: number;
  status?: ProductStatus;
}): string => `list:${filter.status ?? 'all'}:${filter.limit}:${filter.cursor ?? 'first'}`;

/** JSON turned the dates into strings. */
export function reviveProduct(raw: unknown): ProductDto {
  const product = raw as Omit<ProductDto, 'createdAt' | 'updatedAt'> & {
    createdAt: string;
    updatedAt: string;
  };
  return {
    ...product,
    createdAt: new Date(product.createdAt),
    updatedAt: new Date(product.updatedAt),
  };
}

export function reviveProductPage(raw: unknown): PaginatedByCursor<ProductDto> {
  const page = raw as PaginatedByCursor<unknown>;
  return { items: page.items.map(reviveProduct), nextCursor: page.nextCursor };
}
