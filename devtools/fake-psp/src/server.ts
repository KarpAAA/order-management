// fake-psp: a tiny simulated payment provider. NOT part of the system: it stands in for an
// external PSP so the api worker has something real to call over HTTP.
// Runs directly on Node >= 24 (built-in type stripping), no build step, no dependencies.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import type { IncomingMessage, ServerResponse } from 'node:http';

interface Behaviour {
  latencyMs: number;
  failureRate: number;
  /** Share of calls refused with 429 and a Retry-After: the provider is there, and busy. */
  throttleRate: number;
  declineRate: number;
}

interface Charge {
  id: string;
  status: 'succeeded' | 'declined';
  declineCode?: string;
  amountMinor: number;
  currency: string;
  reference: string;
  idempotencyKey: string;
  createdAt: string;
  /** Set when the charge was taken back. A declined charge moved no money and is never void. */
  voidedAt?: string;
}

const DECLINE_CODES = ['insufficient_funds', 'card_declined', 'expired_card'] as const;

const port = Number(process.env.PORT ?? 4010);
const behaviour: Behaviour = {
  latencyMs: numberFromEnv('FAKE_PSP_LATENCY_MS', 200),
  failureRate: numberFromEnv('FAKE_PSP_FAILURE_RATE', 0),
  throttleRate: numberFromEnv('FAKE_PSP_THROTTLE_RATE', 0),
  declineRate: numberFromEnv('FAKE_PSP_DECLINE_RATE', 0),
};
/** Seconds a throttled caller is told to wait. */
const RETRY_AFTER_SECONDS = 1;
// Idempotency store: the same key always returns exactly the same response.
const chargesByKey = new Map<string, Charge>();
// Calls to the provider itself (charges and voids, not /admin), by the status they got:
// what a caller that says "I stopped calling" is checked against.
const answered = new Map<number, number>();
// Calls to the provider that were taken and not answered yet: how a caller that wants to act
// while a charge is under way knows that one is (the system tests, docs/adr/0022).
let inFlight = 0;

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Answers a call to the provider, and counts it. */
function answer(res: ServerResponse, status: number, body: unknown): void {
  answered.set(status, (answered.get(status) ?? 0) + 1);
  send(res, status, body);
}

/** A failure that passes: 429 with a Retry-After, or 503. Stores nothing. */
function failsForNow(res: ServerResponse): boolean {
  if (Math.random() < behaviour.throttleRate) {
    res.setHeader('retry-after', String(RETRY_AFTER_SECONDS));
    answer(res, 429, { error: 'too many requests' });
    return true;
  }
  if (Math.random() < behaviour.failureRate) {
    answer(res, 503, { error: 'temporarily unavailable' });
    return true;
  }
  return false;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// base latency + up to 50% random jitter
const latency = () => behaviour.latencyMs + Math.random() * behaviour.latencyMs * 0.5;

async function createCharge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') {
    answer(res, 400, { error: 'Idempotency-Key header is required' });
    return;
  }
  const body = await readJson(req);
  const { amountMinor, currency, reference } = body;
  if (
    typeof amountMinor !== 'number' ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    typeof currency !== 'string' ||
    !/^[A-Z]{3}$/.test(currency) ||
    typeof reference !== 'string'
  ) {
    answer(res, 400, {
      error: 'body must be { amountMinor: int >= 0, currency: ISO 4217, reference: string }',
    });
    return;
  }

  await sleep(latency());

  const existing = chargesByKey.get(key);
  if (existing) {
    answer(res, 201, publicView(existing));
    return;
  }
  // A transient failure stores nothing: a retry with the same key gets a fresh chance.
  if (failsForNow(res)) return;
  const declined = Math.random() < behaviour.declineRate;
  const charge: Charge = {
    id: `ch_${randomUUID()}`,
    status: declined ? 'declined' : 'succeeded',
    ...(declined && {
      declineCode: DECLINE_CODES[Math.floor(Math.random() * DECLINE_CODES.length)],
    }),
    amountMinor,
    currency,
    reference,
    idempotencyKey: key,
    createdAt: new Date().toISOString(),
  };
  chargesByKey.set(key, charge);
  log('charge stored', {
    chargeId: charge.id,
    status: charge.status,
    idempotencyKey: key,
    amountMinor,
    currency,
  });
  answer(res, 201, publicView(charge));
}

function publicView(c: Charge) {
  return { id: c.id, status: c.status, ...(c.declineCode && { declineCode: c.declineCode }) };
}

// Takes a charge back. Repeatable: a charge that is void stays void, with its first date.
async function voidCharge(id: string, res: ServerResponse): Promise<void> {
  await sleep(latency());

  const charge = [...chargesByKey.values()].find((c) => c.id === id);
  if (!charge) {
    answer(res, 404, { error: `no charge ${id}` });
    return;
  }
  if (failsForNow(res)) return;
  if (charge.status === 'succeeded' && charge.voidedAt === undefined) {
    charge.voidedAt = new Date().toISOString();
    log('charge voided', { chargeId: charge.id, idempotencyKey: charge.idempotencyKey });
  }
  answer(res, 200, { id: charge.id, status: 'voided' });
}

async function updateConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const next = { ...behaviour };
  for (const field of ['latencyMs', 'failureRate', 'throttleRate', 'declineRate'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    const isRate = field !== 'latencyMs';
    if (typeof value !== 'number' || value < 0 || (isRate && value > 1)) {
      send(res, 400, { error: `${field} must be a number${isRate ? ' in [0, 1]' : ' >= 0'}` });
      return;
    }
    next[field] = value;
  }
  Object.assign(behaviour, next);
  log('config changed', { ...behaviour });
  send(res, 200, behaviour);
}

/** Runs one call to the provider, counted as under way until it is answered. */
async function underWay(call: () => Promise<void>): Promise<void> {
  inFlight += 1;
  try {
    await call();
  } finally {
    inFlight -= 1;
  }
}

/**
 * One JSON line, in the shape the services log in (docs/adr/0023), so that a provider's side
 * of a charge is read with theirs.
 */
function log(msg: string, fields: Record<string, unknown> = {}): void {
  const line = {
    level: 'info',
    time: new Date().toISOString(),
    service: 'fake-psp',
    ...fields,
    msg,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * One call to the provider: counted as under way, and logged when it is answered, under the
 * chain its caller named (`x-correlation-id`). A real provider would log a request id of its
 * own; this one keeps the caller's, so one id finds the charge on both sides.
 */
function called(
  operation: string,
  req: IncomingMessage,
  res: ServerResponse,
  call: () => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  const correlationId = req.headers['x-correlation-id'];
  return underWay(async () => {
    try {
      await call();
    } finally {
      log('call', {
        ...(typeof correlationId === 'string' ? { correlationId } : {}),
        operation,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

const VOID_ROUTE = /^POST \/charges\/([^/]+)\/void$/;

const server = createServer((req, res) => {
  const route = `${req.method ?? ''} ${(req.url ?? '').split('?')[0] ?? ''}`;
  const handle = async () => {
    const voided = VOID_ROUTE.exec(route)?.[1];
    if (voided !== undefined) {
      return called('void', req, res, () => voidCharge(decodeURIComponent(voided), res));
    }
    switch (route) {
      case 'POST /charges':
        return called('charge', req, res, () => createCharge(req, res));
      case 'GET /charges':
        return send(res, 200, [...chargesByKey.values()]);
      case 'GET /admin/config':
        return send(res, 200, behaviour);
      case 'POST /admin/config':
        return updateConfig(req, res);
      case 'GET /admin/stats':
        return send(res, 200, {
          calls: [...answered.values()].reduce((sum, count) => sum + count, 0),
          byStatus: Object.fromEntries(answered),
          inFlight,
        });
      case 'POST /admin/reset':
        chargesByKey.clear();
        answered.clear();
        log('reset');
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: `no route ${route}` });
    }
  };
  handle().catch((err: unknown) => {
    send(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
  });
});

server.listen(port, () => log('listening', { port, ...behaviour }));
