// Tenant isolation below the HTTP layer, in its two lines of defence:
//  - TEN-006: the tenant-scope extension (the single choke point) on the real scoped client;
//  - TEN-005: the composite foreign keys of the schema, even for a raw write that bypasses it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SCOPED_PRISMA, type ScopedPrismaClient } from '@infra/database/database.tokens';
import { newId } from '@shared/domain/id';
import {
  TenantContextMissingError,
  TenantMismatchError,
} from '@shared/errors/tenant-context-missing.error';

import { OrderStatus } from '@modules/orders/domain/order-status';

import { orderFactory } from '../factories';
import { createIntModule, type IntModule } from '../helpers/int-module';
import { PRODUCT_ACME_ACTIVE, PRODUCT_GLOBEX_ACTIVE, WS_ACME, WS_GLOBEX } from '../seed/ids';
import { testDb } from '../setup/db';

let app: IntModule;
let scoped: ScopedPrismaClient;

beforeAll(async () => {
  app = await createIntModule({ providers: [] });
  scoped = app.get<ScopedPrismaClient>(SCOPED_PRISMA);
});
afterAll(() => app.close());

const inAcme = <T>(work: () => Promise<T>): Promise<T> => app.inWorkspaceTx(WS_ACME, work);

describe('tenant-scope extension (TEN-006)', () => {
  it('refuses to read a tenant table without a tenant in context', async () => {
    await expect(scoped.product.findMany()).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('refuses to write a tenant table without a tenant in context', async () => {
    await expect(
      scoped.product.create({
        data: { workspaceId: WS_ACME, id: newId(), sku: 'NO-TENANT', name: 'x', priceMinor: 1n },
      }),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(await testDb().product.count({ where: { sku: 'NO-TENANT' } })).toBe(0);
  });

  it("returns only the context tenant's rows", async () => {
    const ids = await inAcme(async () => (await scoped.product.findMany()).map((p) => p.id));
    expect(ids).toContain(PRODUCT_ACME_ACTIVE);
    expect(ids).not.toContain(PRODUCT_GLOBEX_ACTIVE);
  });

  it("cannot reach another tenant's row even by its id", async () => {
    const found = await inAcme(() =>
      scoped.product.findFirst({ where: { id: PRODUCT_GLOBEX_ACTIVE } }),
    );
    expect(found).toBeNull();
  });

  it('refuses a write that names another workspace', async () => {
    await expect(
      inAcme(() =>
        scoped.product.create({
          data: { workspaceId: WS_GLOBEX, id: newId(), sku: 'SMUGGLED', name: 'x', priceMinor: 1n },
        }),
      ),
    ).rejects.toBeInstanceOf(TenantMismatchError);
    expect(await testDb().product.count({ where: { sku: 'SMUGGLED' } })).toBe(0);
  });
});

describe('composite foreign keys (TEN-005)', () => {
  it("rejects an order line that points at another workspace's product", async () => {
    const order = await orderFactory.create({ status: OrderStatus.Draft }); // acme

    await expect(
      testDb().orderItem.create({
        data: {
          workspaceId: WS_ACME,
          id: newId(),
          orderId: order.id,
          position: 1,
          productId: PRODUCT_GLOBEX_ACTIVE, // exists — but in globex
          sku: 'GLOBEX-ACTIVE',
          name: 'Globex active product',
          unitPriceMinor: 2000n,
          quantity: 1,
          lineTotalMinor: 2000n,
        },
      }),
    ).rejects.toThrow(/order_items_workspace_id_product_id_fkey/);
  });
});
