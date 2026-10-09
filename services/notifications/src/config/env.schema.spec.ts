import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

// The smallest environment the schema accepts: everything else has a safe default.
const minimal = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://notifications_app:notifications_app@localhost:5436/notifications',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'Orders <orders@oms.local>',
};

describe('validateEnv: safe defaults (ops/config-env.md §1)', () => {
  it('requires NODE_ENV: a deploy that forgets it must not boot as development', () => {
    expect(() => validateEnv({ ...minimal, NODE_ENV: undefined })).toThrow(/NODE_ENV/);
  });

  it('works on 10 events at a time by default and refuses none', () => {
    expect(validateEnv(minimal).RABBITMQ_PREFETCH).toBe(10);
    expect(() => validateEnv({ ...minimal, RABBITMQ_PREFETCH: '0' })).toThrow(/RABBITMQ_PREFETCH/);
  });

  it('delivers an event 4 times, 2 s apart, unless told otherwise', () => {
    const env = validateEnv(minimal);
    expect(env.NOTIFICATIONS_ORDER_EVENTS_MAX_ATTEMPTS).toBe(4);
    expect(env.RABBITMQ_RETRY_DELAY_MS).toBe(2000);
    // unset: the queue follows the delay of the broker
    expect(env.NOTIFICATIONS_ORDER_EVENTS_RETRY_DELAY_MS).toBeUndefined();
    expect(() => validateEnv({ ...minimal, NOTIFICATIONS_ORDER_EVENTS_MAX_ATTEMPTS: '0' })).toThrow(
      /NOTIFICATIONS_ORDER_EVENTS_MAX_ATTEMPTS/,
    );
  });

  it('parks a message whose consumer died with it 10 times, and never waits for the broker to give up', () => {
    expect(validateEnv(minimal).RABBITMQ_REDELIVERY_LIMIT).toBe(10);
    // 20 is where the broker dead-letters the message itself
    expect(() => validateEnv({ ...minimal, RABBITMQ_REDELIVERY_LIMIT: '20' })).toThrow(
      /RABBITMQ_REDELIVERY_LIMIT/,
    );
  });

  it('refuses a broker URL that is not AMQP', () => {
    expect(() => validateEnv({ ...minimal, RABBITMQ_URL: 'redis://localhost:6379' })).toThrow(
      /RABBITMQ_URL/,
    );
  });

  it('refuses a database URL that is not Postgres', () => {
    expect(() => validateEnv({ ...minimal, DATABASE_URL: 'mysql://localhost/notifications' })) //
      .toThrow(/DATABASE_URL/);
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM'])(
    'requires %s: there is no mail server to guess',
    (key) => {
      expect(() => validateEnv({ ...minimal, [key]: undefined })).toThrow(new RegExp(key));
    },
  );

  it('speaks plain SMTP with no login and gives one mail 5 s by default', () => {
    const env = validateEnv(minimal);
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.SMTP_TIMEOUT_MS).toBe(5000);
  });

  it.each([{ SMTP_USER: 'mailer' }, { SMTP_PASSWORD: 'secret' }])(
    'refuses half a login: %o',
    (half) => {
      expect(() => validateEnv({ ...minimal, ...half })).toThrow(/SMTP_PASSWORD/);
    },
  );

  it('tries a mail 5 times, the second try 30 s after the first, and keeps it 30 days', () => {
    const env = validateEnv(minimal);
    expect(env.NOTIFICATIONS_DISPATCH_ENABLED).toBe(true);
    expect(env.NOTIFICATIONS_MAX_SEND_ATTEMPTS).toBe(5);
    expect(env.NOTIFICATIONS_SEND_RETRY_DELAY_MS).toBe(30_000);
    expect(env.NOTIFICATIONS_RETENTION_DAYS).toBe(30);
    expect(() => validateEnv({ ...minimal, NOTIFICATIONS_MAX_SEND_ATTEMPTS: '0' })).toThrow(
      /NOTIFICATIONS_MAX_SEND_ATTEMPTS/,
    );
  });

  it('boots in production with nothing more', () => {
    expect(validateEnv({ ...minimal, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });
});
