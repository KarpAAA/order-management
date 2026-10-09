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

  it('gives the provider 2 s for a call and 7 s for an operation with its retries', () => {
    const env = validateEnv(minimal);
    expect(env.PSP_TIMEOUT_MS).toBe(2000);
    expect(env.PSP_CALL_BUDGET_MS).toBe(7000);
    expect(env.PSP_MAX_RETRIES).toBe(2);
    // every delivery with its budget and the waits in between, below the 150 s the api waits
    const worstCase =
      env.PAYMENTS_COMMANDS_MAX_ATTEMPTS * (env.PSP_CALL_BUDGET_MS + env.PSP_RETRY_MAX_DELAY_MS) +
      (env.PAYMENTS_COMMANDS_MAX_ATTEMPTS - 1) * env.RABBITMQ_RETRY_DELAY_MS;
    expect(worstCase).toBeLessThan(150_000);
  });

  it('refuses a budget below one call, and a longest pause below the first', () => {
    expect(() =>
      validateEnv({ ...minimal, PSP_TIMEOUT_MS: '3000', PSP_CALL_BUDGET_MS: '2000' }),
    ).toThrow(/PSP_CALL_BUDGET_MS/);
    expect(() =>
      validateEnv({ ...minimal, PSP_RETRY_INITIAL_DELAY_MS: '500', PSP_RETRY_MAX_DELAY_MS: '100' }),
    ).toThrow(/PSP_RETRY_MAX_DELAY_MS/);
  });

  it('opens the breaker above 80 % of at least 10 calls in 10 s, for 10 s', () => {
    const env = validateEnv(minimal);
    expect(env.PSP_BREAKER_THRESHOLD).toBe(0.8);
    expect(env.PSP_BREAKER_MIN_CALLS).toBe(10);
    expect(env.PSP_BREAKER_WINDOW_MS).toBe(10_000);
    expect(env.PSP_BREAKER_HALF_OPEN_MS).toBe(10_000);
    // a share: neither "never" nor "at the first failure"
    for (const threshold of ['0', '1']) {
      expect(() => validateEnv({ ...minimal, PSP_BREAKER_THRESHOLD: threshold })).toThrow(
        /PSP_BREAKER_THRESHOLD/,
      );
    }
  });

  it('allows one call per delivery: no retry in the process', () => {
    expect(validateEnv({ ...minimal, PSP_MAX_RETRIES: '0' }).PSP_MAX_RETRIES).toBe(0);
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
