import { registerAs } from '@nestjs/config';

import { validateEnv } from './env.schema';

import type { ConfigType } from '@nestjs/config';

// Validated once per process; every namespace reads from the same parsed object.
let cached: ReturnType<typeof validateEnv> | undefined;
const env = () => (cached ??= validateEnv(process.env));

export const loggingConfig = registerAs('logging', () => ({
  level: env().LOG_LEVEL,
  pretty: env().LOG_PRETTY,
}));
export type LoggingConfig = ConfigType<typeof loggingConfig>;

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

export const inboxConfig = registerAs('inbox', () => ({
  retentionDays: env().INBOX_RETENTION_DAYS,
  cleanupIntervalMs: env().INBOX_CLEANUP_INTERVAL_MS,
}));
export type InboxConfig = ConfigType<typeof inboxConfig>;

export const gatewayConfig = registerAs('gateway', () => ({
  gateway: env().PAYMENT_GATEWAY,
  pspBaseUrl: env().PSP_BASE_URL,
  pspTimeoutMs: env().PSP_TIMEOUT_MS,
  pspCallBudgetMs: env().PSP_CALL_BUDGET_MS,
  pspMaxRetries: env().PSP_MAX_RETRIES,
  pspRetryInitialDelayMs: env().PSP_RETRY_INITIAL_DELAY_MS,
  pspRetryMaxDelayMs: env().PSP_RETRY_MAX_DELAY_MS,
  pspBreakerThreshold: env().PSP_BREAKER_THRESHOLD,
  pspBreakerWindowMs: env().PSP_BREAKER_WINDOW_MS,
  pspBreakerMinCalls: env().PSP_BREAKER_MIN_CALLS,
  pspBreakerHalfOpenMs: env().PSP_BREAKER_HALF_OPEN_MS,
}));
export type GatewayConfig = ConfigType<typeof gatewayConfig>;

export const allConfigs = [
  loggingConfig,
  databaseConfig,
  rabbitConfig,
  outboxConfig,
  inboxConfig,
  gatewayConfig,
];
