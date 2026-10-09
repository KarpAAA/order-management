// Where the stack of the run is, and what it was seeded with. Nothing is imported from a
// service: the ids are spelled out again, as services/inventory/prisma/seed.ts does.
// README.md → "Seeded data" lists them.

const port = (name: string, fallback: number): string => process.env[name] ?? String(fallback);

/** The three windows of a test, on the host ports of docker-compose.system.yml. */
export const stack = {
  api: `http://127.0.0.1:${port('SYSTEM_API_PORT', 3100)}`,
  psp: `http://127.0.0.1:${port('SYSTEM_PSP_PORT', 4110)}`,
  mailpit: `http://127.0.0.1:${port('SYSTEM_MAILPIT_PORT', 8125)}`,
};

/** `01990000-0000-7000-8000-<group><n in hex>` (services/api/prisma/seed-data.ts). */
const seedId = (group: string, n: number): string =>
  `01990000-0000-7000-8000-${group}${n.toString(16).padStart(12 - group.length, '0')}`;

export const PASSWORD = 'Passw0rd!';

/** acme: EUR, 20 % tax. Its MEMBER may create, place and cancel orders. */
export const WORKSPACE_ID = seedId('a0', 0);
export const MEMBER_EMAIL = 'member@acme.test';

export const PRODUCTS = {
  /** 100 on hand. */
  stocked: seedId('a1', 1),
  /** 100 on hand, another product: a scenario that holds stock does not meet another one's. */
  alsoStocked: seedId('a1', 2),
  /** No stock at all (services/inventory/prisma/seed.ts → UNSTOCKED_PRODUCT). */
  unstocked: seedId('a1', 17),
  /** One on hand (LAST_UNIT_PRODUCT): held by one attempt, it is there for no other. */
  lastUnit: seedId('a1', 18),
};
