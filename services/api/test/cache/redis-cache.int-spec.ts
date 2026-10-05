// The stampede protections against a real Redis (CCH-004): every RedisCache below has its own
// connection and its own in-flight map, which is what a second api process is.
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisCache, type StampedeProtection } from '@infra/cache/redis-cache';
import type { ReadSource } from '@infra/database/read-source';
import { RedisService } from '@infra/redis/redis.service';

const PROCESSES = 4;
const CALLERS = 200;
const source = { requirePrimary: () => undefined } as unknown as ReadSource;

let prefix: string;
let connections: RedisService[];

beforeAll(() => {
  prefix = process.env.CACHE_PREFIX ?? '';
  const url = process.env.REDIS_URL ?? '';
  connections = Array.from(
    { length: PROCESSES + 1 },
    () => new RedisService({ url, queuePrefix: 'unused' }),
  );
});
afterAll(() => {
  for (const connection of connections) connection.disconnect();
});

const processes = (): [RedisCache, ...RedisCache[]] =>
  connections
    .slice(0, PROCESSES)
    .map((redis) => new RedisCache(redis, source, { prefix, catalogTtlSeconds: 300 })) as [
    RedisCache,
    ...RedisCache[],
  ];

/** 200 callers spread over 4 processes read one empty key; returns how many loads ran. */
async function stampede(key: string, protection: StampedeProtection): Promise<number> {
  const caches = processes();
  let loads = 0;
  const load = async () => {
    loads += 1;
    await sleep(100); // long enough for every caller to miss before the first value is stored
    return 'value';
  };
  const values = await Promise.all(
    Array.from({ length: CALLERS }, (_, i) =>
      (caches[i % PROCESSES] ?? caches[0]).getOrLoad({
        namespace: 'int',
        key,
        ttlSeconds: 60,
        load,
        protection,
      }),
    ),
  );
  expect(new Set(values)).toEqual(new Set(['value']));
  return loads;
}

describe('200 callers on an empty key, from 4 processes (CCH-004)', () => {
  it('every caller loads without protection', async () => {
    expect(await stampede('none', 'none')).toBe(CALLERS);
  });

  it('one load per process with single-flight', async () => {
    expect(await stampede('single-flight', 'single-flight')).toBe(PROCESSES);
  });

  it('one load in all with the lock, and no lock left behind', async () => {
    expect(await stampede('lock', 'lock')).toBe(1);

    expect(await connections[0]?.keys(`${prefix}:lock:*`)).toEqual([]);
  });
});

describe('a lock held by someone else (CCH-004)', () => {
  it('is waited out, never deleted: the caller loads by itself and leaves the lock alone', async () => {
    const [cache] = processes();
    const redis = connections[PROCESSES];
    const lockKey = `${prefix}:lock:int:v0:abandoned`;
    await redis?.set(lockKey, 'someone-else', 'PX', 60_000);

    const value = await cache.getOrLoad({
      namespace: 'int',
      key: 'abandoned',
      ttlSeconds: 60,
      load: () => Promise.resolve('loaded anyway'),
    });

    expect(value).toBe('loaded anyway');
    expect(await redis?.get(lockKey)).toBe('someone-else');
    expect(cache.stats()).toMatchObject({ lockWaits: 1, loads: 1 });
  });
});
