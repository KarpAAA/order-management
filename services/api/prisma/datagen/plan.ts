// Who the tenants are and how big: a few large ones and a long tail (Zipf).
import { DAY, zipfShares } from './random';

import type { DatagenOptions } from './options';
import type { Rng } from './random';

export interface TenantPlan {
  /** 1-based rank: 1 is the largest tenant. */
  rank: number;
  id: string;
  slug: string;
  name: string;
  currency: string;
  taxRateBps: number;
  share: number;
  orderCount: number;
  productCount: number;
  userCount: number;
  /** The tenant's first day: orders start after it, the catalog is created just before. */
  startAt: Date;
}

const CURRENCIES = ['USD', 'EUR', 'UAH', 'GBP', 'PLN'] as const;
const TAX_RATES_BPS = [0, 700, 2000, 2300] as const;
/** The largest tenants have been here since the start of the window. */
const FOUNDERS = 5;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function windowStart(options: DatagenOptions): Date {
  const start = new Date(options.until);
  start.setUTCMonth(start.getUTCMonth() - options.months);
  return start;
}

export function planTenants(options: DatagenOptions, rng: Rng): TenantPlan[] {
  const from = windowStart(options).getTime();
  const span = options.until.getTime() - from;

  return zipfShares(options.tenants).map((share, i) => {
    const rank = i + 1;
    const startAt = new Date(rank <= FOUNDERS ? from : from + Math.floor(rng.next() * 0.8 * span));
    const slug = `gen-${String(rank).padStart(3, '0')}`;
    return {
      rank,
      id: rng.uuidAt(new Date(startAt.getTime() - DAY)),
      slug,
      name: `Generated tenant ${String(rank).padStart(3, '0')}`,
      currency: rng.pick(CURRENCIES),
      taxRateBps: rng.pick(TAX_RATES_BPS),
      share,
      orderCount: Math.max(1, Math.round(share * options.orders)),
      productCount: clamp(Math.round(20 + share * 20_000), 20, 5_000),
      userCount: clamp(2 + Math.round(share * 200), 2, 40),
      startAt,
    };
  });
}
