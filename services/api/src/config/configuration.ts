import { registerAs } from '@nestjs/config';

import { validateEnv } from './env.schema';

import type { ConfigType } from '@nestjs/config';

// Validated once per process; every namespace reads from the same parsed object.
let cached: ReturnType<typeof validateEnv> | undefined;
const env = () => (cached ??= validateEnv(process.env));

export const appConfig = registerAs('app', () => ({
  port: env().API_PORT,
  corsOrigins: env().CORS_ORIGINS,
  swaggerEnabled: env().SWAGGER_ENABLED,
  bullBoardEnabled: env().BULL_BOARD_ENABLED,
}));
export type AppConfig = ConfigType<typeof appConfig>;

export const databaseConfig = registerAs('database', () => ({
  url: env().DATABASE_URL,
  poolMax: env().DATABASE_POOL_MAX,
  replicaUrl: env().DATABASE_REPLICA_URL,
  readYourWritesTtlSeconds: env().READ_YOUR_WRITES_TTL_SECONDS,
  logQueries: env().DATABASE_LOG_QUERIES,
}));
export type DatabaseConfig = ConfigType<typeof databaseConfig>;

export const redisConfig = registerAs('redis', () => ({
  url: env().REDIS_URL,
  queuePrefix: env().QUEUE_PREFIX,
}));
export type RedisConfig = ConfigType<typeof redisConfig>;

export const cacheConfig = registerAs('cache', () => ({
  prefix: env().CACHE_PREFIX,
  catalogTtlSeconds: env().CATALOG_CACHE_TTL_SECONDS,
}));
export type CacheConfig = ConfigType<typeof cacheConfig>;

/** How often a message of one queue is delivered, and how long it waits in between. */
export interface RetryPolicy {
  maxAttempts: number;
  delayMs: number;
}

export const rabbitConfig = registerAs('rabbit', () => {
  // By queue name, as on the wire. A queue a consumer reads must be listed: the process does
  // not boot otherwise (infrastructure/messaging/rabbit-subscribers.ts).
  const retry: Record<string, RetryPolicy> = {
    'api.payment-events': {
      maxAttempts: env().PAYMENT_EVENTS_MAX_ATTEMPTS,
      delayMs: env().PAYMENT_EVENTS_RETRY_DELAY_MS ?? env().RABBITMQ_RETRY_DELAY_MS,
    },
    'api.inventory-events': {
      maxAttempts: env().INVENTORY_EVENTS_MAX_ATTEMPTS,
      delayMs: env().INVENTORY_EVENTS_RETRY_DELAY_MS ?? env().RABBITMQ_RETRY_DELAY_MS,
    },
    'api.saga-timeouts': {
      maxAttempts: env().SAGA_TIMEOUTS_MAX_ATTEMPTS,
      delayMs: env().SAGA_TIMEOUTS_RETRY_DELAY_MS ?? env().RABBITMQ_RETRY_DELAY_MS,
    },
  };
  // By the queue that reads the messages when their wait is over: the delays a message for it
  // may be given. Each is a queue `<queue>.delay.<ms>`, declared with the consumer of `queue`
  // (infrastructure/messaging/delay-topology.ts).
  const delays: Record<string, number[]> = {
    // the timeouts of the saga steps (orderSagaConfig): each is a queue of its own
    'api.saga-timeouts': [
      env().ORDER_SAGA_RESERVE_TIMEOUT_MS,
      env().ORDER_SAGA_CHARGE_TIMEOUT_MS,
      env().ORDER_SAGA_COMPENSATION_TIMEOUT_MS,
    ],
  };
  return {
    url: env().RABBITMQ_URL,
    prefetch: env().RABBITMQ_PREFETCH,
    redeliveryLimit: env().RABBITMQ_REDELIVERY_LIMIT,
    retry,
    delays,
  };
});
export type RabbitConfig = ConfigType<typeof rabbitConfig>;

export const outboxConfig = registerAs('outbox', () => ({
  relayEnabled: env().OUTBOX_RELAY_ENABLED,
  pollIntervalMs: env().OUTBOX_POLL_INTERVAL_MS,
  batchSize: env().OUTBOX_BATCH_SIZE,
  publishTimeoutMs: env().OUTBOX_PUBLISH_TIMEOUT_MS,
  retentionDays: env().OUTBOX_RETENTION_DAYS,
}));
export type OutboxConfig = ConfigType<typeof outboxConfig>;

export const inboxConfig = registerAs('inbox', () => ({
  retentionDays: env().INBOX_RETENTION_DAYS,
}));
export type InboxConfig = ConfigType<typeof inboxConfig>;

export const authConfig = registerAs('auth', () => ({
  jwtSecret: env().JWT_SECRET,
  accessTtlSeconds: env().JWT_ACCESS_TTL_SECONDS,
}));
export type AuthConfig = ConfigType<typeof authConfig>;

export const ordersQueueConfig = registerAs('ordersQueue', () => ({
  concurrency: env().ORDERS_WORKER_CONCURRENCY,
}));
export type OrdersQueueConfig = ConfigType<typeof ordersQueueConfig>;

export const orderEventsConfig = registerAs('orderEvents', () => ({
  partitionsAhead: env().ORDER_EVENTS_PARTITIONS_AHEAD,
  retentionMonths: env().ORDER_EVENTS_RETENTION_MONTHS,
  partitionsEnabled: env().ORDER_EVENTS_PARTITIONS_ENABLED,
}));
export type OrderEventsConfig = ConfigType<typeof orderEventsConfig>;

export const orderSagaConfig = registerAs('orderSaga', () => ({
  reserveTimeoutMs: env().ORDER_SAGA_RESERVE_TIMEOUT_MS,
  chargeTimeoutMs: env().ORDER_SAGA_CHARGE_TIMEOUT_MS,
  compensationTimeoutMs: env().ORDER_SAGA_COMPENSATION_TIMEOUT_MS,
}));
export type OrderSagaConfig = ConfigType<typeof orderSagaConfig>;

export const allConfigs = [
  appConfig,
  databaseConfig,
  redisConfig,
  cacheConfig,
  rabbitConfig,
  outboxConfig,
  inboxConfig,
  authConfig,
  ordersQueueConfig,
  orderEventsConfig,
  orderSagaConfig,
];
