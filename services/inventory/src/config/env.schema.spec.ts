import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

// The smallest environment the schema accepts: everything else has a safe default.
const minimal = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://inventory_app:inventory_app@localhost:5435/inventory',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
};

describe('validateEnv: safe defaults (ops/config-env.md §1)', () => {
  it('requires NODE_ENV: a deploy that forgets it must not boot as development', () => {
    expect(() => validateEnv({ ...minimal, NODE_ENV: undefined })).toThrow(/NODE_ENV/);
  });

  it('works on 10 commands at a time by default and refuses none', () => {
    expect(validateEnv(minimal).RABBITMQ_PREFETCH).toBe(10);
    expect(() => validateEnv({ ...minimal, RABBITMQ_PREFETCH: '0' })).toThrow(/RABBITMQ_PREFETCH/);
  });

  it('delivers a command 4 times, 2 s apart, unless told otherwise', () => {
    const env = validateEnv(minimal);
    expect(env.INVENTORY_COMMANDS_MAX_ATTEMPTS).toBe(4);
    expect(env.RABBITMQ_RETRY_DELAY_MS).toBe(2000);
    // unset: the queue follows the delay of the broker
    expect(env.INVENTORY_COMMANDS_RETRY_DELAY_MS).toBeUndefined();
    expect(() => validateEnv({ ...minimal, INVENTORY_COMMANDS_MAX_ATTEMPTS: '0' })).toThrow(
      /INVENTORY_COMMANDS_MAX_ATTEMPTS/,
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
    expect(() => validateEnv({ ...minimal, DATABASE_URL: 'mysql://localhost/inventory' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('boots in production with nothing more', () => {
    expect(validateEnv({ ...minimal, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });
});
