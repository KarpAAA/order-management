// Fixed seed data. Ids and credentials are listed in README.md → "Seeded data";
// Step 1 tests reuse them, so change them only together with the README.
import { DiscountType } from '../src/modules/orders/domain/discount';

import type {
  OrderEventType,
  OrderStatus,
  WorkspaceRole,
} from '../src/infrastructure/database/generated/prisma/client';
import type { Discount } from '../src/modules/orders/domain/discount';

export const PASSWORD = 'Passw0rd!';

/** `01990000-0000-7000-8000-<group><n in hex>`: valid UUIDv7 layout, readable in logs. */
export const seedId = (group: string, n: number) =>
  `01990000-0000-7000-8000-${group}${n.toString(16).padStart(12 - group.length, '0')}`;

export type WorkspaceKey = 'acme' | 'globex';

export const WORKSPACES: Record<
  WorkspaceKey,
  { id: string; name: string; slug: string; currency: string; taxRateBps: number; group: string }
> = {
  acme: {
    id: seedId('a0', 0),
    name: 'Acme Corp',
    slug: 'acme',
    currency: 'EUR',
    taxRateBps: 2000,
    group: 'a',
  },
  globex: {
    id: seedId('b0', 0),
    name: 'Globex',
    slug: 'globex',
    currency: 'USD',
    taxRateBps: 0,
    group: 'b',
  },
};

export const USERS = {
  acmeOwner: { id: seedId('c0', 0xa1), email: 'owner@acme.test' },
  acmeAdmin: { id: seedId('c0', 0xa2), email: 'admin@acme.test' },
  acmeMember: { id: seedId('c0', 0xa3), email: 'member@acme.test' },
  acmeViewer: { id: seedId('c0', 0xa4), email: 'viewer@acme.test' },
  globexOwner: { id: seedId('c0', 0xb1), email: 'owner@globex.test' },
  globexAdmin: { id: seedId('c0', 0xb2), email: 'admin@globex.test' },
  globexMember: { id: seedId('c0', 0xb3), email: 'member@globex.test' },
  globexViewer: { id: seedId('c0', 0xb4), email: 'viewer@globex.test' },
  both: { id: seedId('c0', 0xc1), email: 'both@example.test' },
};

type UserKey = keyof typeof USERS;

export const MEMBERSHIPS: { ws: WorkspaceKey; n: number; user: UserKey; role: WorkspaceRole }[] = [
  { ws: 'acme', n: 1, user: 'acmeOwner', role: 'OWNER' },
  { ws: 'acme', n: 2, user: 'acmeAdmin', role: 'ADMIN' },
  { ws: 'acme', n: 3, user: 'acmeMember', role: 'MEMBER' },
  { ws: 'acme', n: 4, user: 'acmeViewer', role: 'VIEWER' },
  { ws: 'acme', n: 5, user: 'both', role: 'MEMBER' },
  { ws: 'globex', n: 1, user: 'globexOwner', role: 'OWNER' },
  { ws: 'globex', n: 2, user: 'globexAdmin', role: 'ADMIN' },
  { ws: 'globex', n: 3, user: 'globexMember', role: 'MEMBER' },
  { ws: 'globex', n: 4, user: 'globexViewer', role: 'VIEWER' },
  { ws: 'globex', n: 5, user: 'both', role: 'VIEWER' },
];

/** Who creates and who fulfills the seeded orders of each workspace. */
export const ORDER_ACTORS: Record<WorkspaceKey, { creator: UserKey; fulfiller: UserKey }> = {
  acme: { creator: 'acmeMember', fulfiller: 'acmeAdmin' },
  globex: { creator: 'globexMember', fulfiller: 'globexAdmin' },
};

export const PRODUCT_NAMES = [
  'Coffee mug',
  'Tea cup',
  'Notebook A5',
  'Notebook A4',
  'Gel pen',
  'Pencil set',
  'Desk lamp',
  'Monitor stand',
  'USB-C cable',
  'Mouse pad',
  'Wireless mouse',
  'Keyboard',
  'Water bottle',
  'Backpack',
  'Sticker pack',
  'Hoodie',
  'T-shirt',
  'Cap',
];
/** 1-based product numbers that are ARCHIVED in every workspace. */
export const ARCHIVED_PRODUCTS: ReadonlySet<number> = new Set([4, 11, 16]);

/** The seed writes the status changes of an order, not the steps of its saga in between. */
export type SeedEventType = Exclude<
  OrderEventType,
  | 'STOCK_RESERVED'
  | 'STOCK_RESERVATION_FAILED'
  | 'STOCK_RELEASED'
  | 'PAYMENT_TIMED_OUT'
  | 'CANCELLATION_REQUESTED'
>;

export interface SeedOrder {
  n: number;
  status: OrderStatus;
  lines: { product: number; quantity: number }[];
  discount: Discount;
  /** Status changes in order; the first is always ORDER_CREATED. */
  history: SeedEventType[];
  paymentAttempt: number;
  failureReason?: string;
}

const none: Discount = { type: DiscountType.None };

/** One order per status, plus an empty draft. */
export const ORDERS: SeedOrder[] = [
  {
    n: 1,
    status: 'DRAFT',
    lines: [{ product: 1, quantity: 2 }],
    discount: none,
    history: ['ORDER_CREATED'],
    paymentAttempt: 0,
  },
  {
    n: 2,
    status: 'DRAFT',
    lines: [],
    discount: none,
    history: ['ORDER_CREATED'],
    paymentAttempt: 0,
  },
  {
    n: 3,
    status: 'PENDING_PAYMENT',
    lines: [{ product: 2, quantity: 1 }],
    discount: none,
    history: ['ORDER_CREATED', 'ORDER_PLACED'],
    paymentAttempt: 1,
  },
  {
    n: 4,
    status: 'PAID',
    lines: [
      { product: 3, quantity: 3 },
      { product: 5, quantity: 10 },
    ],
    discount: { type: DiscountType.Percent, valueBps: 1000 },
    history: ['ORDER_CREATED', 'ORDER_PLACED', 'PAYMENT_SUCCEEDED'],
    paymentAttempt: 1,
  },
  {
    n: 5,
    status: 'PAYMENT_FAILED',
    lines: [{ product: 6, quantity: 1 }],
    discount: { type: DiscountType.Fixed, valueMinor: 500n },
    history: ['ORDER_CREATED', 'ORDER_PLACED', 'PAYMENT_FAILED'],
    paymentAttempt: 1,
    failureReason: 'insufficient_funds',
  },
  {
    n: 6,
    status: 'FULFILLED',
    lines: [
      { product: 7, quantity: 1 },
      { product: 8, quantity: 2 },
    ],
    discount: none,
    history: ['ORDER_CREATED', 'ORDER_PLACED', 'PAYMENT_SUCCEEDED', 'ORDER_FULFILLED'],
    paymentAttempt: 1,
  },
  {
    n: 7,
    status: 'CANCELLED',
    lines: [{ product: 9, quantity: 4 }],
    discount: none,
    history: ['ORDER_CREATED', 'ORDER_CANCELLED'],
    paymentAttempt: 0,
  },
];

export const STATUS_AFTER: Record<SeedEventType, OrderStatus> = {
  ORDER_CREATED: 'DRAFT',
  ORDER_PLACED: 'PENDING_PAYMENT',
  PAYMENT_SUCCEEDED: 'PAID',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  ORDER_FULFILLED: 'FULFILLED',
  ORDER_CANCELLED: 'CANCELLED',
};

const BASE_TIME = Date.parse('2026-09-01T09:00:00.000Z');
/** Deterministic timestamps: `minutes` after the seed epoch. */
export const seedTime = (minutes: number) => new Date(BASE_TIME + minutes * 60_000);
