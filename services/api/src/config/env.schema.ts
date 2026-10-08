import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  // no default: a deploy that forgets it must not boot as development (ops/config-env.md §1)
  NODE_ENV: z.enum(['development', 'test', 'production']),
  API_PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /**
   * Connections one process keeps open. Behind PgBouncer they are client connections: cheap,
   * and the server side is capped by its `default_pool_size` (docs/adr/0008).
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * The read replica, as the application role. Unset or empty: there is no replica and every
   * read goes to the primary (docs/adr/0009-read-replica-routing.md).
   */
  DATABASE_REPLICA_URL: z
    .union([z.literal(''), z.url({ protocol: /^postgres(ql)?$/ })])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  /**
   * How long after a write the writer's reads are checked against the replica's position. A
   * replica that lags longer than this serves the writer stale rows again: set it above the
   * lag you accept.
   */
  READ_YOUR_WRITES_TTL_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
  /** Emit Prisma `query` events (debug log; the e2e suite counts queries with them). */
  DATABASE_LOG_QUERIES: booleanString.default(false),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Namespace of every BullMQ key in Redis; the e2e suite gives each test file its own. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default('bull'),
  /** Namespace of every cache key in Redis; the e2e suite gives each test file its own. */
  CACHE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default('cache'),
  /**
   * How long a cached product or list page lives, before jitter. A change through the API
   * invalidates at once; this bounds what a write past the API (seed, datagen) or a lost
   * invalidation leaves behind. 0 switches the catalog cache off (docs/adr/0010).
   */
  CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
  /** The broker between the services; the path is the vhost (the e2e suite gives each test file its own). */
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }),
  /** Messages one process works on at a time: unacknowledged messages the broker hands it. */
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
   * Deliveries of one payment event before it is parked. The charge is made by then and
   * nobody waits for an answer, so giving up early only makes work for an operator.
   */
  PAYMENT_EVENTS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
  /** The delay of `api.payment-events` alone; unset: RABBITMQ_RETRY_DELAY_MS. */
  PAYMENT_EVENTS_RETRY_DELAY_MS: z.coerce.number().int().min(1).optional(),

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
  /** Days a published message is kept before the cleanup job deletes it. */
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),

  JWT_SECRET: z.string().min(32),
  // ≤ 15 min (ops/security.md §3); with refresh: none a leaked token lives this long
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(900),

  ORDERS_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),

  /** Monthly `order_events` partitions kept ready after the current month. */
  ORDER_EVENTS_PARTITIONS_AHEAD: z.coerce.number().int().min(1).max(12).default(3),
  /** Full months of order history kept besides the current one; 0 keeps everything. */
  ORDER_EVENTS_RETENTION_MONTHS: z.coerce.number().int().min(0).default(0),
  /** Switches the partition maintenance job off without a deploy (transport/cron.md §3). */
  ORDER_EVENTS_PARTITIONS_ENABLED: booleanString.default(true),

  // off unless enabled: bull-board has no auth and can retry or remove jobs (.env.example turns both on)
  SWAGGER_ENABLED: booleanString.default(false),
  BULL_BOARD_ENABLED: booleanString.default(false),
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
  // Boot-time safety checks (ops/config-env.md §3).
  if (env.NODE_ENV === 'production' && (env.SWAGGER_ENABLED || env.BULL_BOARD_ENABLED)) {
    throw new Error('Invalid environment: Swagger and bull-board must be disabled in production');
  }
  return env;
}
