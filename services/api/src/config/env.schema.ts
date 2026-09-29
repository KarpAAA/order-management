import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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

  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(900),

  PAYMENT_GATEWAY: z.enum(['http', 'fake']).default('fake'),
  PSP_BASE_URL: z.url().default('http://localhost:4010'),
  PSP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  ORDERS_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  CHARGE_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  CHARGE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),

  SWAGGER_ENABLED: booleanString.default(true),
  BULL_BOARD_ENABLED: booleanString.default(true),
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
  // Boot-time safety checks — the only place NODE_ENV is read (ops/config-env.md §3).
  if (env.NODE_ENV === 'production' && (env.SWAGGER_ENABLED || env.BULL_BOARD_ENABLED)) {
    throw new Error('Invalid environment: Swagger and bull-board must be disabled in production');
  }
  return env;
}
