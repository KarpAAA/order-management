import { parseArgs } from 'node:util';

export type Scale = 'smoke' | 'full';

export interface DatagenOptions {
  scale: Scale;
  seed: number;
  tenants: number;
  orders: number;
  months: number;
  /** Nothing happens after this moment; the default is today 00:00 UTC. */
  until: Date;
}

const PRESETS: Record<Scale, Pick<DatagenOptions, 'tenants' | 'orders' | 'months'>> = {
  smoke: { tenants: 10, orders: 20_000, months: 6 },
  full: { tenants: 100, orders: 2_000_000, months: 24 },
};

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

export function parseOptions(argv: readonly string[]): DatagenOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      scale: { type: 'string', default: 'full' },
      seed: { type: 'string' },
      tenants: { type: 'string' },
      orders: { type: 'string' },
      months: { type: 'string' },
      until: { type: 'string' },
    },
    strict: true,
  });
  if (values.scale !== 'smoke' && values.scale !== 'full') {
    throw new Error('--scale must be smoke or full');
  }
  const preset = PRESETS[values.scale];

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const until = values.until === undefined ? today : new Date(values.until);
  if (Number.isNaN(until.getTime())) throw new Error('--until must be an ISO date');

  return {
    scale: values.scale,
    seed: positiveInt('seed', values.seed, 42),
    tenants: positiveInt('tenants', values.tenants, preset.tenants),
    orders: positiveInt('orders', values.orders, preset.orders),
    months: positiveInt('months', values.months, preset.months),
    until,
  };
}
