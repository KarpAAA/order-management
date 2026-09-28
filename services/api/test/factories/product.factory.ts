import { faker } from '@faker-js/faker';
import { Factory } from 'fishery';

import type { Product } from '@infra/database/generated/prisma/client';
import { newId } from '@shared/domain/id';

import { WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

/** An ACTIVE product in acme unless overridden; SKU is unique within the workspace. */
export const productFactory = Factory.define<Product>(({ sequence, onCreate }) => {
  onCreate((product) => testDb().product.create({ data: product }));

  const now = new Date();
  return {
    workspaceId: WS_ACME,
    id: newId(),
    sku: `TST-${String(sequence)}`,
    name: faker.commerce.productName(),
    description: null,
    priceMinor: 1250n,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
});
