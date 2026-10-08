import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

// The smallest environment the schema accepts: everything else has a safe default.
const minimal = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://payments_app:payments_app@localhost:5434/payments',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
};

describe('validateEnv: safe defaults (ops/config-env.md §1)', () => {
  it('requires NODE_ENV: a deploy that forgets it must not boot as development', () => {
    expect(() => validateEnv({ ...minimal, NODE_ENV: undefined })).toThrow(/NODE_ENV/);
  });

  it('runs on the in-process gateway unless the real one is asked for', () => {
    expect(validateEnv(minimal).PAYMENT_GATEWAY).toBe('fake');
  });

  it('gives the provider 3 s to answer by default', () => {
    expect(validateEnv(minimal).PSP_TIMEOUT_MS).toBe(3000);
  });

  it('works on 10 commands at a time by default and refuses none', () => {
    expect(validateEnv(minimal).RABBITMQ_PREFETCH).toBe(10);
    expect(() => validateEnv({ ...minimal, RABBITMQ_PREFETCH: '0' })).toThrow(/RABBITMQ_PREFETCH/);
  });

  it('delivers a command 4 times, 30 s apart, unless told otherwise', () => {
    const env = validateEnv(minimal);
    expect(env.PAYMENTS_COMMANDS_MAX_ATTEMPTS).toBe(4);
    expect(env.RABBITMQ_RETRY_DELAY_MS).toBe(30_000);
    // unset: the queue follows the delay of the broker
    expect(env.PAYMENTS_COMMANDS_RETRY_DELAY_MS).toBeUndefined();
    expect(() => validateEnv({ ...minimal, PAYMENTS_COMMANDS_MAX_ATTEMPTS: '0' })).toThrow(
      /PAYMENTS_COMMANDS_MAX_ATTEMPTS/,
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
});

describe('validateEnv: production boot checks (ops/config-env.md §3)', () => {
  const production = { ...minimal, NODE_ENV: 'production', PAYMENT_GATEWAY: 'http' };

  it('boots with the real gateway', () => {
    expect(validateEnv(production).NODE_ENV).toBe('production');
  });

  it('refuses the fake gateway: a charge would be reported with no money moved', () => {
    expect(() => validateEnv({ ...production, PAYMENT_GATEWAY: 'fake' })).toThrow(
      /PAYMENT_GATEWAY/,
    );
  });

  it('refuses the default gateway too: the default is the fake one', () => {
    expect(() => validateEnv({ ...minimal, NODE_ENV: 'production' })).toThrow(/PAYMENT_GATEWAY/);
  });
});
