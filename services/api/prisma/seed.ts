// Dev seed: fixed ids, idempotent (upsert / skipDuplicates), safe to run repeatedly.
// The data lives in seed-data.ts; README.md → "Seeded data" lists ids and credentials.
import { PrismaPg } from '@prisma/adapter-pg';

import { Money } from '@shared/domain/money';

import { PrismaClient } from '../src/infrastructure/database/generated/prisma/client';
import { DiscountType } from '../src/modules/orders/domain/discount';
import { calculateTotals } from '../src/modules/orders/domain/order-totals';

import {
  ARCHIVED_PRODUCTS,
  ORDER_ACTORS,
  ORDERS,
  PASSWORD,
  PRODUCT_NAMES,
  seedId,
  seedTime,
  STATUS_AFTER,
  USERS,
  WORKSPACES,
} from './seed-data';
import { seedIdentity } from './seed-identity';

import type { SeedOrder, WorkspaceKey } from './seed-data';
import type { OrderEventType } from '../src/infrastructure/database/generated/prisma/client';

try {
  process.loadEnvFile('.env');
} catch {
  // env comes from the shell
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed a production database');
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

type ProductRow = ReturnType<typeof productRows>[number];

function productRows(ws: WorkspaceKey) {
  const { id: workspaceId, group } = WORKSPACES[ws];
  const prefix = ws === 'acme' ? 'ACM' : 'GBX';
  return PRODUCT_NAMES.map((name, i) => ({
    workspaceId,
    id: seedId(`${group}1`, i + 1),
    sku: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    name,
    description: i % 3 === 0 ? `${name}, seeded for local development` : null,
    priceMinor: BigInt(299 + i * 250),
    status: ARCHIVED_PRODUCTS.has(i + 1) ? ('ARCHIVED' as const) : ('ACTIVE' as const),
    createdAt: seedTime(i),
  }));
}

function orderLines(order: SeedOrder, products: readonly ProductRow[], currency: string) {
  return order.lines.map((line, position) => {
    const product = products[line.product - 1];
    if (!product)
      throw new Error(`Seed order ${order.n} references unknown product ${line.product}`);
    const unitPrice = Money.of(product.priceMinor, currency);
    return {
      position,
      product,
      quantity: line.quantity,
      unitPrice,
      lineTotal: unitPrice.multiply(line.quantity),
    };
  });
}

async function seedOrder(ws: WorkspaceKey, order: SeedOrder, products: readonly ProductRow[]) {
  const { id: workspaceId, currency, taxRateBps, group } = WORKSPACES[ws];
  const creator = USERS[ORDER_ACTORS[ws].creator].id;
  const fulfiller = USERS[ORDER_ACTORS[ws].fulfiller].id;
  const orderId = seedId(`${group}2`, order.n);
  const lines = orderLines(order, products, currency);
  const totals = calculateTotals({
    currency,
    lineTotals: lines.map((l) => l.lineTotal),
    discount: order.discount,
    taxRateBps,
  });
  const eventTime = (i: number) => seedTime(100 + order.n * 10 + i);
  const reached = (type: OrderEventType) => {
    const i = order.history.indexOf(type);
    return i === -1 ? null : eventTime(i);
  };
  const actorOf = (type: OrderEventType) => {
    if (type === 'PAYMENT_SUCCEEDED' || type === 'PAYMENT_FAILED') return 'system:consumer:orders';
    return type === 'ORDER_FULFILLED' ? fulfiller : creator;
  };

  await prisma.order.upsert({
    where: { workspaceId_id: { workspaceId, id: orderId } },
    update: {},
    create: {
      workspaceId,
      id: orderId,
      status: order.status,
      currency,
      discountType: order.discount.type,
      discountValueBps:
        order.discount.type === DiscountType.Percent ? order.discount.valueBps : null,
      discountValueMinor:
        order.discount.type === DiscountType.Fixed ? order.discount.valueMinor : null,
      taxRateBps,
      subtotalMinor: totals.subtotal.amountMinor,
      discountMinor: totals.discount.amountMinor,
      taxMinor: totals.tax.amountMinor,
      totalMinor: totals.total.amountMinor,
      paymentAttempt: order.paymentAttempt,
      pspChargeId: order.history.includes('PAYMENT_SUCCEEDED') ? `ch_seed_${orderId}` : null,
      failureReason: order.failureReason ?? null,
      createdBy: creator,
      createdAt: eventTime(0),
      updatedAt: eventTime(order.history.length - 1),
      placedAt: reached('ORDER_PLACED'),
      paidAt: reached('PAYMENT_SUCCEEDED'),
      fulfilledAt: reached('ORDER_FULFILLED'),
      cancelledAt: reached('ORDER_CANCELLED'),
    },
  });
  await prisma.orderItem.createMany({
    skipDuplicates: true,
    data: lines.map((line) => ({
      workspaceId,
      id: seedId(`${group}3`, order.n * 100 + line.position),
      orderId,
      position: line.position,
      productId: line.product.id,
      sku: line.product.sku,
      name: line.product.name,
      unitPriceMinor: line.unitPrice.amountMinor,
      quantity: line.quantity,
      lineTotalMinor: line.lineTotal.amountMinor,
    })),
  });
  await prisma.orderEvent.createMany({
    skipDuplicates: true,
    data: order.history.map((type, i) => ({
      workspaceId,
      id: seedId(`${group}4`, order.n * 100 + i),
      orderId,
      type,
      fromStatus: i === 0 ? null : STATUS_AFTER[order.history[i - 1] ?? 'ORDER_CREATED'],
      toStatus: STATUS_AFTER[type],
      actor: actorOf(type),
      payload: type === 'ORDER_PLACED' ? { paymentAttempt: 1 } : {},
      createdAt: eventTime(i),
    })),
  });
}

async function seedWorkspaceData(ws: WorkspaceKey): Promise<void> {
  const products = productRows(ws);
  await prisma.product.createMany({ data: products, skipDuplicates: true });
  for (const order of ORDERS) await seedOrder(ws, order, products);
}

async function main(): Promise<void> {
  await seedIdentity(prisma);
  await seedWorkspaceData('acme');
  await seedWorkspaceData('globex');
  process.stdout.write(
    `Seeded acme=${WORKSPACES.acme.id} globex=${WORKSPACES.globex.id}; password for every user: ${PASSWORD}\n`,
  );
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
