import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  // no default: a deploy that forgets it must not boot as development (ops/config-env.md §1)
  NODE_ENV: z.enum(['development', 'test', 'production']),

  /** The lowest level that is written (ops/logging.md §2). */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Lines for a human (pino-pretty) instead of JSON: a terminal in development, never a deploy. */
  LOG_PRETTY: booleanString.default(false),

  /** The application role: it reads and writes rows and cannot run DDL. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /** The broker between the services; the path is the vhost (the e2e suite gives each test file its own). */
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }),
  /** Commands one process works on at a time: unacknowledged messages the broker hands it. */
  RABBITMQ_PREFETCH: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * How long a message whose handling failed waits before it is delivered again. Short: what
   * fails here is a write that met another one (a reservation changed meanwhile, two rows of
   * the same key), and the second try finds what the first writer left.
   */
  RABBITMQ_RETRY_DELAY_MS: z.coerce.number().int().min(1).default(2000),
  /**
   * How many times the broker may take a message back from a consumer that died holding it
   * before the message is parked unhandled. Below 20, the limit at which the broker itself
   * dead-letters it: that message cannot come back from the wait queue (docs/adr/0013).
   */
  RABBITMQ_REDELIVERY_LIMIT: z.coerce.number().int().min(1).max(19).default(10),
  /** Deliveries of one command before it is parked in `inventory.commands.dlq`, unanswered. */
  INVENTORY_COMMANDS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(4),
  /** The delay of `inventory.commands` alone; unset: RABBITMQ_RETRY_DELAY_MS. */
  INVENTORY_COMMANDS_RETRY_DELAY_MS: z.coerce.number().int().min(1).optional(),

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
  return env;
}
