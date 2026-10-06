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

export const authConfig = registerAs('auth', () => ({
  jwtSecret: env().JWT_SECRET,
  accessTtlSeconds: env().JWT_ACCESS_TTL_SECONDS,
}));
export type AuthConfig = ConfigType<typeof authConfig>;

export const paymentsConfig = registerAs('payments', () => ({
  gateway: env().PAYMENT_GATEWAY,
  pspBaseUrl: env().PSP_BASE_URL,
  pspTimeoutMs: env().PSP_TIMEOUT_MS,
}));
export type PaymentsConfig = ConfigType<typeof paymentsConfig>;

export const ordersQueueConfig = registerAs('ordersQueue', () => ({
  concurrency: env().ORDERS_WORKER_CONCURRENCY,
  chargeAttempts: env().CHARGE_ATTEMPTS,
  chargeBackoffMs: env().CHARGE_BACKOFF_MS,
}));
export type OrdersQueueConfig = ConfigType<typeof ordersQueueConfig>;

export const orderEventsConfig = registerAs('orderEvents', () => ({
  partitionsAhead: env().ORDER_EVENTS_PARTITIONS_AHEAD,
  retentionMonths: env().ORDER_EVENTS_RETENTION_MONTHS,
  partitionsEnabled: env().ORDER_EVENTS_PARTITIONS_ENABLED,
}));
export type OrderEventsConfig = ConfigType<typeof orderEventsConfig>;

export const allConfigs = [
  appConfig,
  databaseConfig,
  redisConfig,
  cacheConfig,
  authConfig,
  paymentsConfig,
  ordersQueueConfig,
  orderEventsConfig,
];
