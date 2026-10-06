import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { CacheConfig } from '@config/configuration';
import type { ReadSource } from '@infra/database/read-source';
import type { RedisService } from '@infra/redis/redis.service';

import { RedisCache, withJitter } from './redis-cache';

const config: CacheConfig = { prefix: 't', catalogTtlSeconds: 300 };
const NS = 'catalog:ws-1';

/** In-memory stand-in for Redis: the five commands the cache sends; `down` fails them all. */
function setup(opts: { down?: boolean } = {}) {
  const state = { down: opts.down ?? false };
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const call = <T>(work: () => T): Promise<T> =>
    state.down ? Promise.reject(new Error('redis is down')) : Promise.resolve(work());
  const redis = {
    get: (key: string) => call(() => data.get(key) ?? null),
    set: (key: string, value: string, ...[, ttl, nx]: ['EX' | 'PX', number, 'NX'?]) =>
      call(() => {
        if (nx && data.has(key)) return null;
        data.set(key, value);
        ttls.set(key, ttl);
        return 'OK';
      }),
    incr: (key: string) =>
      call(() => {
        const next = Number(data.get(key) ?? '0') + 1;
        data.set(key, String(next));
        return next;
      }),
    eval: (_script: string, _keys: number, key: string, token: string) =>
      call(() => (data.get(key) === token && data.delete(key) ? 1 : 0)),
  } as unknown as RedisService;
  const calls: string[] = [];
  const source = { requirePrimary: () => calls.push('primary') } as unknown as ReadSource;
  const cache = new RedisCache(redis, source, config);
  const loader = (value: unknown) =>
    vi.fn(() => {
      calls.push('load');
      return Promise.resolve(value);
    });
  return { cache, data, ttls, state, calls, loader };
}

const entry = <T>(load: () => Promise<T>, key = 'product:p-1') => ({
  namespace: NS,
  key,
  ttlSeconds: 300,
  load,
});

beforeAll(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('RedisCache.getOrLoad (CCH-001, CCH-004)', () => {
  it('loads on a miss, stores with a TTL around the asked one, and serves the next read', async () => {
    const { cache, ttls, loader } = setup();
    const load = loader({ name: 'Lamp' });

    expect(await cache.getOrLoad(entry(load))).toEqual({ name: 'Lamp' });
    expect(await cache.getOrLoad(entry(load))).toEqual({ name: 'Lamp' });

    expect(load).toHaveBeenCalledTimes(1);
    const ttl = ttls.get('t:catalog:ws-1:v0:product:p-1');
    expect(ttl).toBeGreaterThanOrEqual(270);
    expect(ttl).toBeLessThanOrEqual(330);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, loads: 1 });
  });

  it('takes the replica away before it loads: a fill reads the primary', async () => {
    const { cache, calls, loader } = setup();

    await cache.getOrLoad(entry(loader(1)));

    expect(calls).toEqual(['primary', 'load']);
  });

  it('passes what it parsed through revive', async () => {
    const { cache, loader } = setup();
    const at = new Date('2026-10-05T10:00:00.000Z');
    const revive = (raw: unknown) => ({ at: new Date((raw as { at: string }).at) });
    await cache.getOrLoad({ ...entry(loader({ at })), revive });

    const again = await cache.getOrLoad({ ...entry(loader(null)), revive });

    expect(again).toEqual({ at });
  });

  it('runs one load for callers that miss together, and releases the lock', async () => {
    const { cache, data, loader } = setup();
    const load = loader('value');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => cache.getOrLoad(entry(load))),
    );

    expect(results).toEqual(Array.from({ length: 50 }, () => 'value'));
    expect(load).toHaveBeenCalledTimes(1);
    expect([...data.keys()]).toEqual(['t:catalog:ws-1:v0:product:p-1']);
  });

  it('loads once per caller without protection', async () => {
    const { cache, loader } = setup();
    const load = loader('value');

    await Promise.all(
      Array.from({ length: 5 }, () => cache.getOrLoad({ ...entry(load), protection: 'none' })),
    );

    expect(load).toHaveBeenCalledTimes(5);
  });

  it('does not store a failed load, and fails every caller that waited for it', async () => {
    const { cache, data, loader } = setup();
    const load = vi.fn(() => Promise.reject(new Error('not found')));

    const results = await Promise.allSettled([
      cache.getOrLoad(entry(load)),
      cache.getOrLoad(entry(load)),
    ]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(load).toHaveBeenCalledTimes(1);
    expect(data.size).toBe(0);
    expect(await cache.getOrLoad(entry(loader('later')))).toBe('later');
  });

  it('reads past the cache with a TTL of 0', async () => {
    const { cache, data, loader } = setup();
    const load = loader('value');

    await cache.getOrLoad({ ...entry(load), ttlSeconds: 0 });
    await cache.getOrLoad({ ...entry(load), ttlSeconds: 0 });

    expect(load).toHaveBeenCalledTimes(2);
    expect(data.size).toBe(0);
  });
});

describe('RedisCache.invalidate (CCH-002)', () => {
  it('moves the namespace to a new version: every key of the old one is a miss', async () => {
    const { cache, loader } = setup();
    await cache.getOrLoad(entry(loader('old')));
    await cache.getOrLoad(entry(loader('old page'), 'list:all:20:first'));

    await cache.invalidate(NS);

    expect(await cache.getOrLoad(entry(loader('new')))).toBe('new');
    expect(await cache.getOrLoad(entry(loader('new page'), 'list:all:20:first'))).toBe('new page');
  });

  it('leaves another namespace alone', async () => {
    const { cache, loader } = setup();
    const other = { ...entry(loader('theirs')), namespace: 'catalog:ws-2' };
    await cache.getOrLoad(other);

    await cache.invalidate(NS);

    expect(await cache.getOrLoad({ ...other, load: loader('reloaded') })).toBe('theirs');
  });

  it('a load that began before the change stores under the old version', async () => {
    const { cache, loader } = setup();
    let release: (value: string) => void = () => undefined;
    const slow = () =>
      new Promise<string>((resolve) => {
        release = resolve;
      });
    const reader = cache.getOrLoad(entry(slow));
    await vi.waitFor(() => {
      expect(cache.stats().loads).toBe(1);
    });

    await cache.invalidate(NS);
    release('read before the change');
    await reader;

    expect(await cache.getOrLoad(entry(loader('after the change')))).toBe('after the change');
  });
});

describe('RedisCache without Redis (CCH-005)', () => {
  it('serves from the database and never throws', async () => {
    const { cache, loader } = setup({ down: true });
    const load = loader('from the database');

    expect(await cache.getOrLoad(entry(load))).toBe('from the database');
    expect(await cache.getOrLoad(entry(load))).toBe('from the database');
    await expect(cache.invalidate(NS)).resolves.toBeUndefined();

    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.stats().errors).toBe(3);
  });

  it('returns the loaded value when only the store fails', async () => {
    const { cache, state } = setup();
    const load = () => {
      state.down = true;
      return Promise.resolve('loaded');
    };

    expect(await cache.getOrLoad(entry(load))).toBe('loaded');
  });
});

describe('withJitter', () => {
  it('spreads a TTL over ±10 % and never goes below a second', () => {
    expect(withJitter(300, () => 0)).toBe(270);
    expect(withJitter(300, () => 0.5)).toBe(300);
    expect(withJitter(300, () => 1)).toBe(330);
    expect(withJitter(1, () => 0)).toBe(1);
  });
});
