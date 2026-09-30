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
  /** Emit Prisma `query` events (debug log; the e2e suite counts queries with them). */
  DATABASE_LOG_QUERIES: booleanString.default(false),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Namespace of every BullMQ key in Redis; the e2e suite gives each test file its own. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default('bull'),

  JWT_SECRET: z.string().min(32),
  // ≤ 15 min (ops/security.md §3); with refresh: none a leaked token lives this long
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(900),

  PAYMENT_GATEWAY: z.enum(['http', 'fake']).default('fake'),
  PSP_BASE_URL: z.url().default('http://localhost:4010'),
  PSP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  ORDERS_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  CHARGE_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  CHARGE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),

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
  // the fake gateway marks orders PAID with no money moved
  if (env.NODE_ENV === 'production' && env.PAYMENT_GATEWAY === 'fake') {
    throw new Error('Invalid environment: PAYMENT_GATEWAY=fake is not allowed in production');
  }
  return env;
}
