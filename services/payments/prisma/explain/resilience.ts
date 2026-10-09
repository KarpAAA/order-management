// Roadmap 3.11: the call to a provider that fails. What three gateways do with it:
//   one call          a call per operation, as before 3.11
//   retry             the call is made again within the operation (PSP_MAX_RETRIES)
//   retry + breaker   and the provider is not called while most calls fail (what the service runs)
// against a provider that is healthy, fails 10 % and 50 % of the calls, is down, and hangs.
//
// The gateway is the real one (HttpPaymentGateway with the defaults of env.schema.ts), the
// provider is fake-psp over HTTP. The operations arrive at a steady rate and at most
// CONSUMER_SLOTS run at once, as the commands of `payments.commands` do under
// RABBITMQ_PREFETCH. The broker is not here: "failed for now" is where the service would
// send the command to its wait queue. No database, in spite of the folder: the script lives
// with the other `db:explain:*` ones.
// Needs `pnpm infra:up` (fake-psp). Run: pnpm db:explain:resilience   (docs/perf/3.11-resilience.md)
import { Logger, type LoggerService } from '@nestjs/common';

import type { GatewayConfig } from '@config/configuration';
import { validateEnv } from '@config/env.schema';

import { HttpPaymentGateway } from '@modules/payments/infrastructure/http-payment-gateway.adapter';
import type { PaymentGateway } from '@modules/payments/ports/payment-gateway.port';

const PSP_URL = process.env.PSP_BASE_URL ?? 'http://localhost:4010';
/** Operations that arrive per second, and for how long. */
const ARRIVALS_PER_SECOND = 10;
const SECONDS = 15;
/** Operations under way at once: RABBITMQ_PREFETCH of the service. */
const CONSUMER_SLOTS = 10;
const NEVER = 1_000_000;

const print = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// the defaults of the schema, not whatever the local .env says
const env = validateEnv({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
  RABBITMQ_URL: 'amqp://unused:unused@localhost:1',
});
const defaults: GatewayConfig = {
  gateway: 'http',
  pspBaseUrl: PSP_URL,
  pspTimeoutMs: env.PSP_TIMEOUT_MS,
  pspCallBudgetMs: env.PSP_CALL_BUDGET_MS,
  pspMaxRetries: env.PSP_MAX_RETRIES,
  pspRetryInitialDelayMs: env.PSP_RETRY_INITIAL_DELAY_MS,
  pspRetryMaxDelayMs: env.PSP_RETRY_MAX_DELAY_MS,
  pspBreakerThreshold: env.PSP_BREAKER_THRESHOLD,
  pspBreakerWindowMs: env.PSP_BREAKER_WINDOW_MS,
  pspBreakerMinCalls: env.PSP_BREAKER_MIN_CALLS,
  pspBreakerHalfOpenMs: env.PSP_BREAKER_HALF_OPEN_MS,
};

const GATEWAYS: { name: string; config: GatewayConfig }[] = [
  { name: 'one call', config: { ...defaults, pspMaxRetries: 0, pspBreakerMinCalls: NEVER } },
  { name: 'retry', config: { ...defaults, pspBreakerMinCalls: NEVER } },
  { name: 'retry + breaker', config: defaults },
];

interface Provider {
  name: string;
  latencyMs: number;
  failureRate: number;
}
const PROVIDERS: Provider[] = [
  { name: 'healthy', latencyMs: 50, failureRate: 0 },
  { name: 'fails 10 %', latencyMs: 50, failureRate: 0.1 },
  { name: 'fails 50 %', latencyMs: 50, failureRate: 0.5 },
  { name: 'down (503)', latencyMs: 50, failureRate: 1 },
  // above PSP_TIMEOUT_MS with its 50 % jitter: every call ends in the timeout
  { name: 'hangs', latencyMs: env.PSP_TIMEOUT_MS * 2, failureRate: 0 },
];

async function admin(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, PSP_URL), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`fake-psp ${path}: ${String(response.status)}`);
  return response.json();
}

/** Calls the provider got since the last reset. */
const callsAtProvider = async (): Promise<number> =>
  ((await admin('/admin/stats')) as { calls: number }).calls;

// The gateway logs every call; only "the circuit opened" is of interest here.
let opened = 0;
const logger: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  error: (message: unknown) => {
    if (String(message).startsWith('psp circuit opened')) opened += 1;
  },
};
Logger.overrideLogger(logger);

interface Result {
  charged: number;
  failedForNow: number;
  /** Of the failed: ended on an open circuit, with no call or with no further call. */
  circuitOpen: number;
  /** Arrived and never got a slot before the run ended. */
  leftWaiting: number;
  durations: number[];
}

async function charge(gateway: PaymentGateway, key: string, result: Result): Promise<void> {
  const startedAt = performance.now();
  try {
    await gateway.charge({
      amount: { amountMinor: 12_50n, currency: 'EUR' },
      reference: key,
      idempotencyKey: `${key}:1`,
    });
    result.charged += 1;
  } catch (err: unknown) {
    result.failedForNow += 1;
    if (err instanceof Error && err.message.startsWith('PSP circuit is open')) {
      result.circuitOpen += 1;
    }
  }
  result.durations.push(performance.now() - startedAt);
}

/** A steady stream of operations into a fixed number of slots, for SECONDS. */
async function run(gateway: PaymentGateway, label: string): Promise<Result> {
  const result: Result = {
    charged: 0,
    failedForNow: 0,
    circuitOpen: 0,
    leftWaiting: 0,
    durations: [],
  };
  const waiting: string[] = [];
  let arriving = true;

  const slot = async (): Promise<void> => {
    while (arriving) {
      const key = waiting.shift();
      if (key === undefined) await sleep(5);
      else await charge(gateway, key, result);
    }
  };
  const slots = Array.from({ length: CONSUMER_SLOTS }, slot);

  const total = ARRIVALS_PER_SECOND * SECONDS;
  for (let i = 0; i < total; i += 1) {
    waiting.push(`${label}-${String(i)}`);
    await sleep(1000 / ARRIVALS_PER_SECOND);
  }
  arriving = false;
  await Promise.all(slots);
  result.leftWaiting = waiting.length;
  return result;
}

const percentile = (values: number[], p: number): string => {
  if (values.length === 0) return '-';
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return String(Math.round(sorted[at] ?? 0));
};

const COLUMNS = [
  ['gateway', 16],
  ['charged', 8],
  ['failed for now', 15],
  ['circuit open', 13],
  ['left waiting', 13],
  ['calls at PSP', 13],
  ['p50 ms', 7],
  ['p95 ms', 7],
  ['opened', 7],
] as const;
const row = (cells: (string | number)[]): string =>
  cells.map((cell, i) => String(cell).padEnd(COLUMNS[i]?.[1] ?? 0)).join(' ');

async function main(): Promise<void> {
  const before = await admin('/admin/config');
  const total = ARRIVALS_PER_SECOND * SECONDS;
  print(
    `${String(total)} charges per run: ${String(ARRIVALS_PER_SECOND)} a second for ` +
      `${String(SECONDS)} s, ${String(CONSUMER_SLOTS)} at once. Defaults: a call ` +
      `${String(env.PSP_TIMEOUT_MS)} ms, an operation ${String(env.PSP_CALL_BUDGET_MS)} ms, ` +
      `${String(env.PSP_MAX_RETRIES)} retries; the breaker opens above ` +
      `${String(env.PSP_BREAKER_THRESHOLD * 100)} % of at least ${String(env.PSP_BREAKER_MIN_CALLS)} ` +
      `calls in ${String(env.PSP_BREAKER_WINDOW_MS / 1000)} s, for ` +
      `${String(env.PSP_BREAKER_HALF_OPEN_MS / 1000)} s.`,
  );

  try {
    for (const provider of PROVIDERS) {
      const { name, ...behaviour } = provider;
      print(`\n== the provider ${name} ==`);
      print(row(COLUMNS.map(([title]) => title)));
      for (const { name: gatewayName, config } of GATEWAYS) {
        await admin('/admin/reset', {});
        await admin('/admin/config', { ...behaviour, declineRate: 0, throttleRate: 0 });
        opened = 0;
        // a gateway of its own: the breaker starts closed
        const result = await run(new HttpPaymentGateway(config), `${name}/${gatewayName}`);
        print(
          row([
            gatewayName,
            result.charged,
            result.failedForNow,
            result.circuitOpen,
            result.leftWaiting,
            await callsAtProvider(),
            percentile(result.durations, 50),
            percentile(result.durations, 95),
            opened,
          ]),
        );
      }
    }
  } finally {
    await admin('/admin/reset', {});
    await admin('/admin/config', before);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
