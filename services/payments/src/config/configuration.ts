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

export const rabbitConfig = registerAs('rabbit', () => ({
  url: env().RABBITMQ_URL,
  prefetch: env().RABBITMQ_PREFETCH,
}));
export type RabbitConfig = ConfigType<typeof rabbitConfig>;

export const gatewayConfig = registerAs('gateway', () => ({
  gateway: env().PAYMENT_GATEWAY,
  pspBaseUrl: env().PSP_BASE_URL,
  pspTimeoutMs: env().PSP_TIMEOUT_MS,
}));
export type GatewayConfig = ConfigType<typeof gatewayConfig>;

export const allConfigs = [databaseConfig, rabbitConfig, gatewayConfig];
