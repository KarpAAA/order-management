import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

// The smallest environment the schema accepts: everything else has a safe default.
const minimal = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://oms:oms@localhost:5432/oms',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  JWT_SECRET: 'x'.repeat(32),
};
const production = {
  ...minimal,
  NODE_ENV: 'production',
  PAYMENT_GATEWAY: 'http',
  SWAGGER_ENABLED: 'false',
  BULL_BOARD_ENABLED: 'false',
};

describe('validateEnv: safe defaults (ops/config-env.md §1)', () => {
  it('requires NODE_ENV: a deploy that forgets it must not boot as development', () => {
    expect(() => validateEnv({ ...minimal, NODE_ENV: undefined })).toThrow(/NODE_ENV/);
  });

  it('keeps Swagger and bull-board off unless enabled', () => {
    const env = validateEnv(minimal);
    expect(env.SWAGGER_ENABLED).toBe(false);
    expect(env.BULL_BOARD_ENABLED).toBe(false);
  });

  it('charges 5 times with a 1 s base backoff by default (PAY-006)', () => {
    const env = validateEnv(minimal);
    expect(env.CHARGE_ATTEMPTS).toBe(5);
    expect(env.CHARGE_BACKOFF_MS).toBe(1000);
  });

  it('keeps three history partitions ahead and never drops history by default', () => {
    const env = validateEnv(minimal);
    expect(env.ORDER_EVENTS_PARTITIONS_AHEAD).toBe(3);
    expect(env.ORDER_EVENTS_RETENTION_MONTHS).toBe(0);
    expect(env.ORDER_EVENTS_PARTITIONS_ENABLED).toBe(true);
  });

  it('opens up to 10 database connections per process by default and refuses a pool of zero', () => {
    expect(validateEnv(minimal).DATABASE_POOL_MAX).toBe(10);
    expect(() => validateEnv({ ...minimal, DATABASE_POOL_MAX: '0' })).toThrow(/DATABASE_POOL_MAX/);
  });

  it('has no read replica unless one is configured, and takes an empty value as none', () => {
    expect(validateEnv(minimal).DATABASE_REPLICA_URL).toBeUndefined();
    expect(
      validateEnv({ ...minimal, DATABASE_REPLICA_URL: '' }).DATABASE_REPLICA_URL,
    ).toBeUndefined();
    expect(() => validateEnv({ ...minimal, DATABASE_REPLICA_URL: 'redis://localhost' })).toThrow(
      /DATABASE_REPLICA_URL/,
    );
  });

  it('checks a writer against the replica for 60 s after a write by default', () => {
    expect(validateEnv(minimal).READ_YOUR_WRITES_TTL_SECONDS).toBe(60);
  });

  it('refuses a look-ahead of zero: the next month would have no partition', () => {
    expect(() => validateEnv({ ...minimal, ORDER_EVENTS_PARTITIONS_AHEAD: '0' })).toThrow(
      /ORDER_EVENTS_PARTITIONS_AHEAD/,
    );
  });
});

describe('validateEnv: access token TTL ≤ 15 min (ops/security.md §3)', () => {
  it('accepts 900 s and refuses 901 s', () => {
    expect(validateEnv({ ...minimal, JWT_ACCESS_TTL_SECONDS: '900' }).JWT_ACCESS_TTL_SECONDS).toBe(
      900,
    );
    expect(() => validateEnv({ ...minimal, JWT_ACCESS_TTL_SECONDS: '901' })).toThrow(
      /JWT_ACCESS_TTL_SECONDS/,
    );
  });
});

describe('validateEnv: production boot checks (ops/config-env.md §3)', () => {
  it('boots with the real gateway and the tools off', () => {
    expect(validateEnv(production).NODE_ENV).toBe('production');
  });

  it('refuses the fake payment gateway: orders would be PAID with no money moved', () => {
    expect(() => validateEnv({ ...production, PAYMENT_GATEWAY: 'fake' })).toThrow(
      /PAYMENT_GATEWAY/,
    );
  });

  it.each(['SWAGGER_ENABLED', 'BULL_BOARD_ENABLED'])('refuses %s=true', (flag) => {
    expect(() => validateEnv({ ...production, [flag]: 'true' })).toThrow(/production/);
  });
});
