// Dev seed: the stock of the products the api seeds (services/api/prisma/seed-data.ts).
// Idempotent: a product that already has stock keeps its levels. Written as the owner, past
// the service: the way stock arrives in a running system is `inventory.adjust-stock`.
// README.md → "Seeded data" lists what is seeded.
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/infrastructure/database/generated/prisma/client';

try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed a production database');
}
const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL is not set');

// The ids of the api's seed, spelled out again: nothing is imported from another service.
// `01990000-0000-7000-8000-<group><n in hex>`; a workspace is `<w>0`/0, its products `<w>1`/1…18.
const seedId = (group: string, n: number) =>
  `01990000-0000-7000-8000-${group}${n.toString(16).padStart(12 - group.length, '0')}`;

const WORKSPACE_GROUPS = ['a', 'b'];
const PRODUCTS = 18;
const ON_HAND = 100;
/** The last unit: two orders that want it are the case the service exists for. */
const LAST_UNIT_PRODUCT = 18;
/** No stock item at all: a reservation of it is rejected with nothing available. */
const UNSTOCKED_PRODUCT = 17;

const SEEDED_AT = new Date('2026-01-01T00:00:00.000Z');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

async function main(): Promise<void> {
  const rows = WORKSPACE_GROUPS.flatMap((group) =>
    Array.from({ length: PRODUCTS }, (_, i) => i + 1)
      .filter((n) => n !== UNSTOCKED_PRODUCT)
      .map((n) => ({
        workspaceId: seedId(`${group}0`, 0),
        productId: seedId(`${group}1`, n),
        onHand: n === LAST_UNIT_PRODUCT ? 1 : ON_HAND,
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      })),
  );
  const { count } = await prisma.stockItem.createMany({ data: rows, skipDuplicates: true });
  process.stdout.write(
    `stock items: ${String(count)} created, ${String(rows.length - count)} kept\n`,
  );
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
