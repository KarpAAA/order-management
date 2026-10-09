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

  it('delivers a payment event 10 times, 30 s apart, unless told otherwise', () => {
    const env = validateEnv(minimal);
    expect(env.PAYMENT_EVENTS_MAX_ATTEMPTS).toBe(10);
    expect(env.RABBITMQ_RETRY_DELAY_MS).toBe(30_000);
    // unset: the queue follows the delay of the broker
    expect(env.PAYMENT_EVENTS_RETRY_DELAY_MS).toBeUndefined();
    expect(() => validateEnv({ ...minimal, PAYMENT_EVENTS_MAX_ATTEMPTS: '0' })).toThrow(
      /PAYMENT_EVENTS_MAX_ATTEMPTS/,
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
  it('boots with the tools off', () => {
    expect(validateEnv(production).NODE_ENV).toBe('production');
  });

  it.each(['SWAGGER_ENABLED', 'BULL_BOARD_ENABLED'])('refuses %s=true', (flag) => {
    expect(() => validateEnv({ ...production, [flag]: 'true' })).toThrow(/production/);
  });
});
