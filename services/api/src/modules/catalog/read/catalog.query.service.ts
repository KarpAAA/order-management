import { Inject, Injectable } from '@nestjs/common';

import { toMoneyDto } from '@common/dto/common.dto';
import { RedisCache } from '@infra/cache/redis-cache';
import { READ_DB, type ReadDb } from '@infra/database/database.tokens';
import type { Prisma } from '@infra/database/generated/prisma/client';
import { afterCursor, newestFirst, toCursorPage } from '@shared/pagination/cursor';
import type { PaginatedByCursor } from '@shared/pagination/cursor';

import { IdentityFacade } from '@modules/identity';

import {
  CATALOG_CACHE_TTL_SECONDS,
  catalogNamespace,
  productKey,
  productListKey,
  reviveProduct,
  reviveProductPage,
} from '../catalog-cache';
import { ProductNotFoundError } from '../errors';
import { ProductStatus } from '../product-status';

import type { ProductDto } from '../catalog.dto';

const productSelect = {
  id: true,
  sku: true,
  name: true,
  description: true,
  priceMinor: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

/** What orders need to snapshot a product into an order line. */
export interface ProductSnapshot {
  id: string;
  sku: string;
  name: string;
  priceMinor: bigint;
  isActive: boolean;
}

const toProductDto = (row: ProductRow, currency: string): ProductDto => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  description: row.description,
  price: toMoneyDto(row.priceMinor, currency),
  status: row.status as ProductStatus, // Prisma enum → domain enum, identical values
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

interface ListFilter {
  cursor?: string;
  limit: number;
  status?: ProductStatus;
}

/**
 * Tenant scope is applied by the database layer; every read is within the current workspace.
 * The two reads behind the screens are cached per workspace (catalog-cache.ts) and
 * invalidated by every write of CatalogService.
 */
@Injectable()
export class CatalogQueryService {
  constructor(
    @Inject(READ_DB) private readonly db: ReadDb,
    private readonly identity: IdentityFacade,
    private readonly cache: RedisCache,
    @Inject(CATALOG_CACHE_TTL_SECONDS) private readonly ttlSeconds: number,
  ) {}

  list(workspaceId: string, filter: ListFilter): Promise<PaginatedByCursor<ProductDto>> {
    return this.cache.getOrLoad({
      namespace: catalogNamespace(workspaceId),
      key: productListKey(filter),
      ttlSeconds: this.ttlSeconds,
      load: () => this.loadList(workspaceId, filter),
      revive: reviveProductPage,
    });
  }

  get(workspaceId: string, productId: string): Promise<ProductDto> {
    return this.cache.getOrLoad({
      namespace: catalogNamespace(workspaceId),
      key: productKey(productId),
      ttlSeconds: this.ttlSeconds,
      load: () => this.loadProduct(workspaceId, productId),
      revive: reviveProduct,
    });
  }

  /**
   * Products by id in the current workspace; unknown ids are simply absent. Never cached: the
   * price it returns is copied into an order for good.
   */
  async findSnapshots(productIds: readonly string[]): Promise<ProductSnapshot[]> {
    const rows = await this.db.product.findMany({
      where: { id: { in: [...productIds] } },
      select: { id: true, sku: true, name: true, priceMinor: true, status: true },
      take: productIds.length,
    });
    return rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      priceMinor: row.priceMinor,
      isActive: (row.status as ProductStatus) === ProductStatus.Active,
    }));
  }

  private async loadList(
    workspaceId: string,
    filter: ListFilter,
  ): Promise<PaginatedByCursor<ProductDto>> {
    const [rows, { currency }] = await Promise.all([
      this.db.product.findMany({
        where: {
          ...(filter.status && { status: filter.status }),
          ...afterCursor(filter.cursor),
        },
        select: productSelect,
        orderBy: newestFirst(),
        take: filter.limit + 1,
      }),
      this.identity.getWorkspaceTerms(workspaceId),
    ]);
    return toCursorPage(rows, filter.limit, (row) => toProductDto(row, currency));
  }

  private async loadProduct(workspaceId: string, productId: string): Promise<ProductDto> {
    const [row, { currency }] = await Promise.all([
      this.db.product.findFirst({ where: { id: productId }, select: productSelect }),
      this.identity.getWorkspaceTerms(workspaceId),
    ]);
    if (!row) throw new ProductNotFoundError(productId);
    return toProductDto(row, currency);
  }
}
