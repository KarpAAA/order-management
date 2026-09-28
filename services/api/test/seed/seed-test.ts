// Test seed: the shared identity world + a minimal catalog where every row has a reason.
// No orders: a test creates the order it needs with orderFactory, so its state is visible
// in the test itself. Runs once into the template database (test/setup/global.ts).
import type { PrismaClient } from '@infra/database/generated/prisma/client';

import { seedIdentity } from '../../prisma/seed-identity';

import {
  PRODUCT_ACME_ACTIVE,
  PRODUCT_ACME_ARCHIVED,
  PRODUCT_GLOBEX_ACTIVE,
  WS_ACME,
  WS_GLOBEX,
} from './ids';

export async function seedTest(prisma: PrismaClient): Promise<void> {
  await seedIdentity(prisma);
  await prisma.product.createMany({
    skipDuplicates: true,
    data: [
      {
        workspaceId: WS_ACME,
        id: PRODUCT_ACME_ACTIVE,
        sku: 'ACME-ACTIVE',
        name: 'Acme active product',
        priceMinor: 1250n,
        status: 'ACTIVE',
      },
      {
        workspaceId: WS_ACME,
        id: PRODUCT_ACME_ARCHIVED,
        sku: 'ACME-ARCHIVED',
        name: 'Acme archived product',
        priceMinor: 999n,
        status: 'ARCHIVED',
      },
      {
        workspaceId: WS_GLOBEX,
        id: PRODUCT_GLOBEX_ACTIVE,
        sku: 'GLOBEX-ACTIVE',
        name: 'Globex active product',
        priceMinor: 2000n,
        status: 'ACTIVE',
      },
    ],
  });
}
