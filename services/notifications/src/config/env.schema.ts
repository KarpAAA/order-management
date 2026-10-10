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
  /**
   * `otlp`: the log lines go to the Collector as well as to stdout (docs/adr/0026). For a
   * process on a developer's machine only: in a container an agent reads stdout, and both
   * would store every line twice. Read by `src/instrumentation.ts`, as the endpoint is.
   */
  OTEL_LOGS_EXPORTER: z.enum(['otlp', 'none']).default('none'),

  /** The application role: it reads and writes rows and cannot run DDL. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /** The broker between the services; the path is the vhost (the e2e suite gives each test file its own). */
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }),
  /** Events one process works on at a time: unacknowledged messages the broker hands it. */
  RABBITMQ_PREFETCH: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * How long a message whose handling failed waits before it is delivered again. Short: what
   * fails here is the database, and handling an event writes one row.
   */
  RABBITMQ_RETRY_DELAY_MS: z.coerce.number().int().min(1).default(2000),
  /**
   * How many times the broker may take a message back from a consumer that died holding it
   * before the message is parked unhandled. Below 20, the limit at which the broker itself
   * dead-letters it: that message cannot come back from the wait queue (docs/adr/0013).
   */
  RABBITMQ_REDELIVERY_LIMIT: z.coerce.number().int().min(1).max(19).default(10),
  /** Deliveries of one event before it is parked in `notifications.order-events.dlq`. */
  NOTIFICATIONS_ORDER_EVENTS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(4),
  /** The delay of `notifications.order-events` alone; unset: RABBITMQ_RETRY_DELAY_MS. */
  NOTIFICATIONS_ORDER_EVENTS_RETRY_DELAY_MS: z.coerce.number().int().min(1).optional(),

  /** The mail server the notifications are handed to (dev: Mailpit, docker-compose.yml). */
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535),
  /** TLS from the first byte (port 465). Off: plain, upgraded when the server offers STARTTLS. */
  SMTP_SECURE: booleanString.default(false),
  /** Both or neither: a server that asks for no login gets none. */
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /**
   * How long one mail may take: to connect, to be greeted, and between two answers. A server
   * that is away does not refuse, it never answers, and the dispatcher holds a row meanwhile.
   */
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(5000),
  /** The sender every mail carries. */
  MAIL_FROM: z.string().min(1),

  /** Switches the dispatcher off without a deploy: notifications wait in the table. */
  NOTIFICATIONS_DISPATCH_ENABLED: booleanString.default(true),
  /** How long the dispatcher sleeps when nothing is due. */
  NOTIFICATIONS_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1000),
  /** Tries of one mail before it is given up (`FAILED`) and somebody is told. */
  NOTIFICATIONS_MAX_SEND_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  /** The wait after the first failed try; it doubles with every next one. */
  NOTIFICATIONS_SEND_RETRY_DELAY_MS: z.coerce.number().int().min(1).default(30_000),
  /** Days a notification that was sent or given up is kept: it holds an address. */
  NOTIFICATIONS_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** How often this process deletes the notifications past the retention. */
  NOTIFICATIONS_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(3_600_000),

  /** Days the record of a handled message is kept: longer than the message may come again. */
  INBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** How often this process deletes the records past the retention. */
  INBOX_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(3_600_000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema
    .refine((env) => (env.SMTP_USER === undefined) === (env.SMTP_PASSWORD === undefined), {
      path: ['SMTP_PASSWORD'],
      message: 'SMTP_USER and SMTP_PASSWORD are set together or not at all',
    })
    .safeParse(raw);
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
