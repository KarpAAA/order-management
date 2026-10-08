import { registerAs } from '@nestjs/config';

import { validateEnv } from './env.schema';

import type { ConfigType } from '@nestjs/config';

// Validated once per process; every namespace reads from the same parsed object.
let cached: ReturnType<typeof validateEnv> | undefined;
const env = () => (cached ??= validateEnv(process.env));

export const databaseConfig = registerAs('database', () => ({
  url: env().DATABASE_URL,
  poolMax: env().DATABASE_POOL_MAX,
}));
export type DatabaseConfig = ConfigType<typeof databaseConfig>;

/** How often a message of one queue is delivered, and how long it waits in between. */
export interface RetryPolicy {
  maxAttempts: number;
  delayMs: number;
}

export const rabbitConfig = registerAs('rabbit', () => {
  // By queue name, as on the wire. A queue a consumer reads must be listed: the process does
  // not boot otherwise (infrastructure/messaging/rabbit-subscribers.ts).
  const retry: Record<string, RetryPolicy> = {
    'payments.commands': {
      maxAttempts: env().PAYMENTS_COMMANDS_MAX_ATTEMPTS,
      delayMs: env().PAYMENTS_COMMANDS_RETRY_DELAY_MS ?? env().RABBITMQ_RETRY_DELAY_MS,
    },
  };
  return {
    url: env().RABBITMQ_URL,
    prefetch: env().RABBITMQ_PREFETCH,
    redeliveryLimit: env().RABBITMQ_REDELIVERY_LIMIT,
    retry,
  };
});
export type RabbitConfig = ConfigType<typeof rabbitConfig>;

export const outboxConfig = registerAs('outbox', () => ({
  relayEnabled: env().OUTBOX_RELAY_ENABLED,
  pollIntervalMs: env().OUTBOX_POLL_INTERVAL_MS,
  batchSize: env().OUTBOX_BATCH_SIZE,
  publishTimeoutMs: env().OUTBOX_PUBLISH_TIMEOUT_MS,
  retentionDays: env().OUTBOX_RETENTION_DAYS,
  cleanupIntervalMs: env().OUTBOX_CLEANUP_INTERVAL_MS,
}));
export type OutboxConfig = ConfigType<typeof outboxConfig>;

export const gatewayConfig = registerAs('gateway', () => ({
  gateway: env().PAYMENT_GATEWAY,
  pspBaseUrl: env().PSP_BASE_URL,
  pspTimeoutMs: env().PSP_TIMEOUT_MS,
}));
export type GatewayConfig = ConfigType<typeof gatewayConfig>;

export const allConfigs = [databaseConfig, rabbitConfig, outboxConfig, gatewayConfig];
