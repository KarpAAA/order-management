// Products of the generated tenants; a few are ARCHIVED, orders only use ACTIVE ones.
import { Faker, en } from '@faker-js/faker';

import { DAY, WeightedSampler, zipfShares } from './random';

import type { TenantPlan } from './plan';
import type { Rng } from './random';
import type { PrismaClient } from '../../src/infrastructure/database/generated/prisma/client';
import type { OrderLineInput } from '../../src/modules/orders/domain/order';

export interface TenantCatalog {
  /** ACTIVE products, most popular first; `sampler` draws them with Zipf popularity. */
  active: Omit<OrderLineInput, 'quantity'>[];
  sampler: WeightedSampler<Omit<OrderLineInput, 'quantity'>>;
}

const MIN_PRICE = 199;
const MAX_PRICE = 50_000;
const ARCHIVED_SHARE = 0.05;
const BATCH = 5_000;

/** Log-uniform: many cheap products, few expensive ones. */
function priceMinor(rng: Rng): bigint {
  const lo = Math.log(MIN_PRICE);
  const hi = Math.log(MAX_PRICE);
  return BigInt(Math.round(Math.exp(lo + rng.next() * (hi - lo))));
}

export async function seedCatalog(
  prisma: PrismaClient,
  tenant: TenantPlan,
  rng: Rng,
): Promise<TenantCatalog> {
  const faker = new Faker({ locale: [en] });
  faker.seed(tenant.rank);

  const rows = Array.from({ length: tenant.productCount }, (_, i) => {
    const createdAt = new Date(tenant.startAt.getTime() - rng.int(1, 30) * DAY + i);
    const name = faker.commerce.productName();
    return {
      workspaceId: tenant.id,
      id: rng.uuidAt(createdAt),
      sku: `GEN-${String(i + 1).padStart(5, '0')}`,
      name,
      description: rng.chance(0.3) ? faker.commerce.productDescription() : null,
      priceMinor: priceMinor(rng),
      status: rng.chance(ARCHIVED_SHARE) ? ('ARCHIVED' as const) : ('ACTIVE' as const),
      createdAt,
    };
  });
  for (let i = 0; i < rows.length; i += BATCH) {
    await prisma.product.createMany({ data: rows.slice(i, i + BATCH) });
  }

  const active = rows
    .filter((r) => r.status === 'ACTIVE')
    .map((r) => ({
      productId: r.id,
      sku: r.sku,
      name: r.name,
      unitPriceMinor: r.priceMinor,
      isActive: true,
    }));
  return { active, sampler: new WeightedSampler(active, zipfShares(active.length, 0.9)) };
}
