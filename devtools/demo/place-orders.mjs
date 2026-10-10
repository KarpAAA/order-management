// Traffic for the dashboards (docs/adr/0027, 0028): a client that keeps placing orders in the
// seeded workspace `acme`, through the HTTP API and nothing else, and tells how they ended.
//
//   pnpm demo:orders                      one order a second, until Ctrl+C
//   pnpm demo:orders -- --interval 250    four a second
//   pnpm demo:orders -- --count 50        fifty, then the summary
//
// Needs the stack (`pnpm infra:up`), the services (`pnpm dev` or the `app` profile) and the
// seed (`pnpm db:seed`, `pnpm db:seed:inventory`). The stock of the seed is spent by it: when
// the orders start coming back as DRAFT (out of stock), seed the inventory again.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.DEMO_API_URL ?? 'http://127.0.0.1:3000' },
    interval: { type: 'string', default: '1000' },
    count: { type: 'string', default: '0' },
  },
});
const INTERVAL_MS = Number(values.interval);
const COUNT = Number(values.count);

const WORKSPACE = '01990000-0000-7000-8000-a00000000000';
const USER = { email: 'member@acme.test', password: 'Passw0rd!' };
// products 1…18 of the seed, without the archived ones (4, 11, 16)
const PRODUCTS = Array.from({ length: 18 }, (_, i) => i + 1)
  .filter((n) => ![4, 11, 16].includes(n))
  .map((n) => `01990000-0000-7000-8000-a100000000${n.toString(16).padStart(2, '0')}`);

async function call(token, method, path, body) {
  const response = await fetch(new URL(path, values.api), {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(method === 'POST' && { 'idempotency-key': randomUUID() }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

const orders = `/v1/workspaces/${WORKSPACE}/orders`;
const pick = () => PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One order: created, placed. Its id, or what the API refused it with. */
async function placeOne(token) {
  const created = await call(token, 'POST', orders, {
    items: [{ productId: pick(), quantity: 1 }],
  });
  if (created.status !== 201) return { refused: `create ${created.status}` };
  const { id } = created.body;
  // an order nobody has changed since it was created is at version 0
  const placed = await call(token, 'POST', `${orders}/${id}/place`, { version: 0 });
  return placed.status === 202 ? { id } : { refused: `place ${placed.status}` };
}

const login = await call(undefined, 'POST', '/v1/auth/login', USER);
if (login.status !== 200) {
  console.error(`login answered ${login.status}: is the api up and the database seeded?`);
  process.exit(1);
}
const token = login.body.accessToken;

const waiting = new Set();
const ended = {};
const count = (what) => {
  ended[what] = (ended[what] ?? 0) + 1;
};

/** Looks at the orders that are still waiting for their payment, and counts the ones that ended. */
async function settle() {
  for (const id of [...waiting]) {
    const { status, body } = await call(token, 'GET', `${orders}/${id}`);
    if (status !== 200 || body.status === 'PENDING_PAYMENT') continue;
    waiting.delete(id);
    count(body.failureReason ? `${body.status} (${body.failureReason})` : body.status);
  }
}

let stopped = false;
process.once('SIGINT', () => {
  stopped = true;
});

console.log(`placing an order every ${INTERVAL_MS} ms at ${values.api} (Ctrl+C ends it)`);
for (let n = 1; !stopped && (COUNT === 0 || n <= COUNT); n += 1) {
  try {
    const order = await placeOne(token);
    if (order.id) waiting.add(order.id);
    else count(order.refused);
    if (n % 10 === 0) {
      await settle();
      console.log(`${n} placed, ${waiting.size} waiting for their payment`, ended);
    }
  } catch (err) {
    count(`no answer (${err.cause?.code ?? err.message})`);
  }
  await sleep(INTERVAL_MS);
}

// what is still under way gets a little time to end
for (let i = 0; i < 20 && waiting.size > 0; i += 1) {
  await sleep(500);
  await settle();
}
console.log('ended:', ended, waiting.size > 0 ? `${waiting.size} still waiting` : '');
