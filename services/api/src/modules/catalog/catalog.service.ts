import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import { TenantContext } from '@common/tenancy/tenant-context';
import { RedisCache } from '@infra/cache/redis-cache';
import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { isRecordNotFound, isUniqueViolation } from '@infra/database/prisma-errors';
import type { Actor } from '@shared/auth/actor';
import { newId } from '@shared/domain/id';

import { catalogNamespace } from './catalog-cache';
import { CatalogPolicy } from './catalog.policy';
import { ProductNotFoundError, SkuTakenError } from './errors';
import { ProductStatus } from './product-status';

export interface CreateProductCommand {
  workspaceId: string;
  sku: string;
  name: string;
  description: string | null;
  priceMinor: bigint;
}

export interface UpdateProductCommand {
  workspaceId: string;
  productId: string;
  name?: string;
  description?: string | null;
  priceMinor?: bigint;
}

/**
 * Write path of the catalog (level 1: two rules, both enforced by constraints). Every write
 * invalidates the workspace's cached products and lists once its row is committed (there is
 * no surrounding transaction: each statement commits by itself).
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly txHost: TransactionHost<DbTransactionAdapter>,
    private readonly policy: CatalogPolicy,
    private readonly tenant: TenantContext,
    private readonly cache: RedisCache,
  ) {}

  async create(cmd: CreateProductCommand, actor: Actor): Promise<{ id: string }> {
    this.policy.assertCanManageProducts(actor, this.tenant.membership());
    const id = newId();
    try {
      await this.txHost.tx.product.create({
        data: {
          workspaceId: cmd.workspaceId,
          id,
          sku: cmd.sku,
          name: cmd.name,
          description: cmd.description,
          priceMinor: cmd.priceMinor,
          status: ProductStatus.Active,
        },
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new SkuTakenError(cmd.sku);
      throw err;
    }
    await this.cache.invalidate(catalogNamespace(cmd.workspaceId));
    return { id };
  }

  async update(cmd: UpdateProductCommand, actor: Actor): Promise<void> {
    this.policy.assertCanManageProducts(actor, this.tenant.membership());
    await this.updateRow(cmd.workspaceId, cmd.productId, {
      ...(cmd.name !== undefined && { name: cmd.name }),
      ...(cmd.description !== undefined && { description: cmd.description }),
      ...(cmd.priceMinor !== undefined && { priceMinor: cmd.priceMinor }),
    });
  }

  /** Idempotent: archiving an archived product is a no-op. */
  async archive(cmd: { workspaceId: string; productId: string }, actor: Actor): Promise<void> {
    this.policy.assertCanManageProducts(actor, this.tenant.membership());
    await this.updateRow(cmd.workspaceId, cmd.productId, { status: ProductStatus.Archived });
  }

  private async updateRow(
    workspaceId: string,
    productId: string,
    data: {
      name?: string;
      description?: string | null;
      priceMinor?: bigint;
      status?: ProductStatus;
    },
  ): Promise<void> {
    try {
      await this.txHost.tx.product.update({
        where: { workspaceId_id: { workspaceId, id: productId } },
        data,
      });
    } catch (err: unknown) {
      if (isRecordNotFound(err)) throw new ProductNotFoundError(productId);
      throw err;
    }
    await this.cache.invalidate(catalogNamespace(workspaceId));
  }
}
