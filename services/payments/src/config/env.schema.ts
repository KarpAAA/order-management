import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  // no default: a deploy that forgets it must not boot as development (ops/config-env.md §1)
  NODE_ENV: z.enum(['development', 'test', 'production']),

  /** The lowest level that is written (ops/logging.md §2). */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Lines for a human (pino-pretty) instead of JSON: a terminal in development, never a deploy. */
  LOG_PRETTY: booleanString.default(false),
  /**
   * The OpenTelemetry Collector, OTLP over HTTP (docs/adr/0024, 0025). Unset or empty: no
   * trace is sent. Read by `src/instrumentation.ts` before this schema is: it is here so
   * that a value that is not a URL stops the boot instead of sending nowhere.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .union([z.literal(''), z.url({ protocol: /^https?$/ })])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  /** The application role: it reads and writes rows and cannot run DDL. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /** The broker between the services; the path is the vhost (the e2e suite gives each test file its own). */
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }),
  /** Commands one process works on at a time: unacknowledged messages the broker hands it. */
  RABBITMQ_PREFETCH: z.coerce.number().int().min(1).max(100).default(10),
  /** How long a message whose handling failed waits before it is delivered again. */
  RABBITMQ_RETRY_DELAY_MS: z.coerce.number().int().min(1).default(30_000),
  /**
   * How many times the broker may take a message back from a consumer that died holding it
   * before the message is parked unhandled. Below 20, the limit at which the broker itself
   * dead-letters it: that message cannot come back from the wait queue (docs/adr/0013).
   */
  RABBITMQ_REDELIVERY_LIMIT: z.coerce.number().int().min(1).max(19).default(10),
  /**
   * Deliveries of one command before it is given up. The api waits for the answer, so the
   * last one ends a provider that is still down as `psp_unavailable`.
   */
  PAYMENTS_COMMANDS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(4),
  /** The delay of `payments.commands` alone; unset: RABBITMQ_RETRY_DELAY_MS. */
  PAYMENTS_COMMANDS_RETRY_DELAY_MS: z.coerce.number().int().min(1).optional(),

  /** Switches the relay of the outbox off without a deploy: messages wait in the table. */
  OUTBOX_RELAY_ENABLED: booleanString.default(true),
  /** How long the relay sleeps after a pass that found less than a full batch. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1000),
  /** Messages one pass of the relay publishes, in one transaction. */
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  /**
   * How long the relay waits for the broker to confirm one message. A broker that is away
   * does not refuse a publish, it never answers: without this the pass would hold its
   * transaction for as long as the broker is down.
   */
  OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  /** Days a published message is kept before the cleanup deletes it. */
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** How often this process deletes the published messages past the retention. */
  OUTBOX_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(3_600_000),

  /** Days the record of a handled message is kept: longer than the message may come again. */
  INBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** How often this process deletes the records past the retention. */
  INBOX_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(3_600_000),

  PAYMENT_GATEWAY: z.enum(['http', 'fake']).default('fake'),
  PSP_BASE_URL: z.url().default('http://localhost:4010'),
  /** How long one call to the provider may take, its body included. */
  PSP_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  /**
   * How long a charge or a void may take in all, with its retries and the pauses between
   * them (a pause that has begun is finished: at most PSP_RETRY_MAX_DELAY_MS more). The
   * command holds its place in the consumer for that long, and the api waits:
   * PAYMENTS_COMMANDS_MAX_ATTEMPTS × this + the delays between the deliveries must stay
   * below ORDER_SAGA_CHARGE_TIMEOUT_MS of the api (docs/adr/0020).
   */
  PSP_CALL_BUDGET_MS: z.coerce.number().int().positive().default(7000),
  /**
   * Calls made again within one delivery after a failure that may pass (5xx, 429, network,
   * timeout); 0: one call per delivery. For a provider that hiccups: one that is down is
   * the business of the breaker and of the next delivery.
   */
  PSP_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** The pause before the first retry; it grows from there, with jitter. */
  PSP_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(1).default(200),
  /**
   * The longest pause between two calls. A provider that asks for more (`Retry-After`) is
   * not waited for in the process: the command comes again.
   */
  PSP_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(2000),
  /**
   * The circuit breaker: with more than this share of the calls of the last
   * PSP_BREAKER_WINDOW_MS failed, the provider is not called for PSP_BREAKER_HALF_OPEN_MS;
   * then one call is let through, and it decides. Well above a half on purpose: a provider
   * that fails every second call is still worth calling, the retry gets most charges
   * through (docs/perf/3.11-resilience.md).
   */
  PSP_BREAKER_THRESHOLD: z.coerce.number().gt(0).lt(1).default(0.8),
  PSP_BREAKER_WINDOW_MS: z.coerce.number().int().min(1000).default(10_000),
  /** Fewer calls than this in the window say nothing: two failures of two are not an outage. */
  PSP_BREAKER_MIN_CALLS: z.coerce.number().int().min(1).default(10),
  PSP_BREAKER_HALF_OPEN_MS: z.coerce.number().int().min(1).default(10_000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.LOG_PRETTY) {
    // what collects the logs reads JSON, and pino-pretty is not in the image
    throw new Error('Invalid environment: LOG_PRETTY must be off in production');
  }
  // Boot-time safety check (ops/config-env.md §3): the fake gateway reports a charge with no
  // money moved, and the api would mark the order PAID.
  if (env.NODE_ENV === 'production' && env.PAYMENT_GATEWAY === 'fake') {
    throw new Error('Invalid environment: PAYMENT_GATEWAY=fake is not allowed in production');
  }
  // a budget below one call would cut every call short and name it a timeout of the provider
  if (env.PSP_CALL_BUDGET_MS < env.PSP_TIMEOUT_MS) {
    throw new Error('Invalid environment: PSP_CALL_BUDGET_MS must not be below PSP_TIMEOUT_MS');
  }
  if (env.PSP_RETRY_MAX_DELAY_MS < env.PSP_RETRY_INITIAL_DELAY_MS) {
    throw new Error(
      'Invalid environment: PSP_RETRY_MAX_DELAY_MS must not be below PSP_RETRY_INITIAL_DELAY_MS',
    );
  }
  return env;
}
