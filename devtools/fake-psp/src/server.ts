// fake-psp: a tiny simulated payment provider. NOT part of the system: it stands in for an
// external PSP so the api worker has something real to call over HTTP.
// Runs directly on Node >= 24 (built-in type stripping), no build step, no dependencies.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import type { IncomingMessage, ServerResponse } from 'node:http';

interface Behaviour {
  latencyMs: number;
  failureRate: number;
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
}

const DECLINE_CODES = ['insufficient_funds', 'card_declined', 'expired_card'] as const;

const port = Number(process.env.PORT ?? 4010);
const behaviour: Behaviour = {
  latencyMs: numberFromEnv('FAKE_PSP_LATENCY_MS', 200),
  failureRate: numberFromEnv('FAKE_PSP_FAILURE_RATE', 0),
  declineRate: numberFromEnv('FAKE_PSP_DECLINE_RATE', 0),
};
// Idempotency store: the same key always returns exactly the same response.
const chargesByKey = new Map<string, Charge>();

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
    send(res, 400, { error: 'Idempotency-Key header is required' });
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
    send(res, 400, {
      error: 'body must be { amountMinor: int >= 0, currency: ISO 4217, reference: string }',
    });
    return;
  }

  await sleep(latency());

  const existing = chargesByKey.get(key);
  if (existing) {
    send(res, 201, publicView(existing));
    return;
  }
  // A transient failure stores nothing: a retry with the same key gets a fresh chance.
  if (Math.random() < behaviour.failureRate) {
    send(res, 503, { error: 'temporarily unavailable' });
    return;
  }
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
  log(`charge ${charge.id} ${charge.status} key=${key} amount=${amountMinor} ${currency}`);
  send(res, 201, publicView(charge));
}

function publicView(c: Charge) {
  return { id: c.id, status: c.status, ...(c.declineCode && { declineCode: c.declineCode }) };
}

async function updateConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const next = { ...behaviour };
  for (const field of ['latencyMs', 'failureRate', 'declineRate'] as const) {
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
  log(`config ${JSON.stringify(behaviour)}`);
  send(res, 200, behaviour);
}

function log(message: string): void {
  process.stdout.write(`[fake-psp] ${new Date().toISOString()} ${message}\n`);
}

const server = createServer((req, res) => {
  const route = `${req.method ?? ''} ${(req.url ?? '').split('?')[0] ?? ''}`;
  const handle = async () => {
    switch (route) {
      case 'POST /charges':
        return createCharge(req, res);
      case 'GET /charges':
        return send(res, 200, [...chargesByKey.values()]);
      case 'GET /admin/config':
        return send(res, 200, behaviour);
      case 'POST /admin/config':
        return updateConfig(req, res);
      case 'POST /admin/reset':
        chargesByKey.clear();
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

server.listen(port, () => log(`listening on :${port} ${JSON.stringify(behaviour)}`));
