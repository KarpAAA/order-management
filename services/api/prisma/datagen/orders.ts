// One order, built the way the app builds it: Order.draft with catalog snapshots, then the real
// transitions, then OrderMapper's rows. Totals, CHECKs and history are consistent by construction.
import { NO_DISCOUNT, DiscountType } from '../../src/modules/orders/domain/discount';
import { Order } from '../../src/modules/orders/domain/order';
import { OrderEventType, OrderStatus } from '../../src/modules/orders/domain/order-status';
import { OrderMapper } from '../../src/modules/orders/infrastructure/order.mapper';

import { DAY, HOUR, MINUTE, WeightedSampler } from './random';

import type { TenantCatalog } from './catalog';
import type { TenantPeople } from './identity';
import type { TenantPlan } from './plan';
import type { Rng } from './random';
import type { Prisma } from '../../src/infrastructure/database/generated/prisma/client';
import type { Discount } from '../../src/modules/orders/domain/discount';
import type { OrderLineInput } from '../../src/modules/orders/domain/order';

export interface TenantContext {
  plan: TenantPlan;
  people: TenantPeople;
  catalog: TenantCatalog;
}

export interface OrderRows {
  order: Prisma.OrderUncheckedCreateInput;
  items: Prisma.OrderItemCreateManyInput[];
  events: Prisma.OrderEventCreateManyInput[];
}

type Step = 'place' | 'pay' | 'decline' | 'fulfill' | 'cancel';

/** Where an order is heading; the walk stops early when the next step would pass `until`. */
const SCENARIOS = WeightedSampler.of<readonly Step[]>([
  [['place', 'pay', 'fulfill'], 85],
  [['place', 'decline', 'place', 'pay', 'fulfill'], 3],
  [['place', 'decline', 'cancel'], 3],
  [['place', 'decline'], 1],
  [['cancel'], 4],
  [[], 4], // abandoned draft
]);

/** [min, max] delay in ms before each step. */
const DELAY: Record<Step | 'retry', readonly [number, number]> = {
  place: [5 * MINUTE, 2 * HOUR],
  retry: [10 * MINUTE, DAY],
  pay: [2_000, 30_000],
  decline: [2_000, 30_000],
  fulfill: [DAY, 5 * DAY],
  cancel: [HOUR, 3 * DAY],
};

const LINE_COUNT = WeightedSampler.of([
  [1, 35],
  [2, 25],
  [3, 18],
  [4, 10],
  [5, 7],
  [6, 2],
  [7, 1],
  [8, 1],
  [10, 1],
]);

const DECLINE_REASONS = ['card_declined', 'insufficient_funds', 'psp_unavailable'] as const;
const PSP_ACTOR = 'system:consumer:orders';

function discountOf(rng: Rng): Discount {
  const roll = rng.next();
  if (roll < 0.8) return NO_DISCOUNT;
  if (roll < 0.92) return { type: DiscountType.Percent, valueBps: rng.int(5, 20) * 100 };
  return { type: DiscountType.Fixed, valueMinor: BigInt(rng.int(1, 20) * 100) };
}

function linesOf(rng: Rng, catalog: TenantCatalog): OrderLineInput[] {
  const wanted = Math.min(LINE_COUNT.sample(rng), catalog.active.length);
  const picked = new Map<string, OrderLineInput>();
  for (let tries = 0; picked.size < wanted && tries < wanted * 10; tries++) {
    const product = catalog.sampler.sample(rng);
    if (!picked.has(product.productId)) {
      picked.set(product.productId, { ...product, quantity: rng.int(1, 5) });
    }
  }
  return [...picked.values()];
}

function applyStep(
  order: Order,
  step: Step,
  at: Date,
  deps: { ctx: TenantContext; rng: Rng },
): void {
  const { ctx, rng } = deps;
  const by = rng.pick(ctx.people.writers);
  const attempt = order.paymentAttempt;
  switch (step) {
    case 'place':
      order.place({ now: at, changedBy: by });
      return;
    case 'pay':
      order.markPaid({ now: at, changedBy: PSP_ACTOR, attempt, pspChargeId: `ch_gen_${order.id}` });
      return;
    case 'decline':
      order.markPaymentFailed({
        now: at,
        changedBy: PSP_ACTOR,
        attempt,
        reason: rng.pick(DECLINE_REASONS),
      });
      return;
    case 'fulfill':
      order.fulfill({ now: at, changedBy: by });
      return;
    case 'cancel':
      order.cancel({ now: at, changedBy: by });
      return;
  }
}

export function buildOrder(ctx: TenantContext, createdAt: Date, until: Date, rng: Rng): OrderRows {
  const order = Order.draft({
    workspaceId: ctx.plan.id,
    currency: ctx.plan.currency,
    taxRateBps: ctx.plan.taxRateBps,
    lines: linesOf(rng, ctx.catalog),
    discount: discountOf(rng),
    createdBy: rng.pick(ctx.people.writers),
    now: createdAt,
  });

  let t = createdAt.getTime();
  for (const step of SCENARIOS.sample(rng)) {
    const isRetry = step === 'place' && order.status === OrderStatus.PaymentFailed;
    const [min, max] = DELAY[isRetry ? 'retry' : step];
    t += rng.int(min, max);
    if (t >= until.getTime()) break;
    applyStep(order, step, new Date(t), { ctx, rng });
  }

  // The domain stamps ids with the current time; re-issue them at the moment they were born
  // in the generated timeline (UUIDv7 order = created_at order), deterministically.
  const orderId = rng.uuidAt(createdAt);
  const chargeId = `ch_gen_${orderId}`;
  const history = order
    .pullHistory()
    .map((entry) =>
      entry.type === OrderEventType.PaymentSucceeded
        ? { ...entry, payload: { ...entry.payload, pspChargeId: chargeId } }
        : entry,
    );
  return {
    order: {
      ...OrderMapper.toCreate(order),
      id: orderId,
      pspChargeId: order.snapshot().pspChargeId === null ? null : chargeId,
    },
    items: OrderMapper.toItemRows(order).map((row) => ({
      ...row,
      id: rng.uuidAt(createdAt),
      orderId,
    })),
    events: OrderMapper.toEventRows(order, history).map((row) => ({
      ...row,
      id: rng.uuidAt(new Date(row.createdAt)),
      orderId,
    })),
  };
}
