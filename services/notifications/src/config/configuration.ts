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
    'notifications.order-events': {
      maxAttempts: env().NOTIFICATIONS_ORDER_EVENTS_MAX_ATTEMPTS,
      delayMs: env().NOTIFICATIONS_ORDER_EVENTS_RETRY_DELAY_MS ?? env().RABBITMQ_RETRY_DELAY_MS,
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

export const mailConfig = registerAs('mail', () => {
  const { SMTP_USER: user, SMTP_PASSWORD: password } = env();
  return {
    host: env().SMTP_HOST,
    port: env().SMTP_PORT,
    secure: env().SMTP_SECURE,
    // the schema lets them in together only
    auth: user !== undefined && password !== undefined ? { user, pass: password } : undefined,
    timeoutMs: env().SMTP_TIMEOUT_MS,
    from: env().MAIL_FROM,
  };
});
export type MailConfig = ConfigType<typeof mailConfig>;

export const notificationsConfig = registerAs('notifications', () => ({
  dispatchEnabled: env().NOTIFICATIONS_DISPATCH_ENABLED,
  dispatchIntervalMs: env().NOTIFICATIONS_DISPATCH_INTERVAL_MS,
  maxSendAttempts: env().NOTIFICATIONS_MAX_SEND_ATTEMPTS,
  sendRetryDelayMs: env().NOTIFICATIONS_SEND_RETRY_DELAY_MS,
  sendTimeoutMs: env().SMTP_TIMEOUT_MS,
  retentionDays: env().NOTIFICATIONS_RETENTION_DAYS,
  cleanupIntervalMs: env().NOTIFICATIONS_CLEANUP_INTERVAL_MS,
}));
export type NotificationsConfig = ConfigType<typeof notificationsConfig>;

export const inboxConfig = registerAs('inbox', () => ({
  retentionDays: env().INBOX_RETENTION_DAYS,
  cleanupIntervalMs: env().INBOX_CLEANUP_INTERVAL_MS,
}));
export type InboxConfig = ConfigType<typeof inboxConfig>;

export const allConfigs = [
  databaseConfig,
  rabbitConfig,
  mailConfig,
  notificationsConfig,
  inboxConfig,
];
