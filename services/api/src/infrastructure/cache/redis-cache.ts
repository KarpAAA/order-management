import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Inject, Injectable } from '@nestjs/common';

import { cacheConfig, type CacheConfig } from '@config/configuration';
import { ReadSource } from '@infra/database/read-source';
import { RedisService } from '@infra/redis/redis.service';
import { LOGGER, type Logger } from '@shared/logger/logger';

/**
 * What stands between an empty key and the database when many callers miss at once:
 *  - none: every caller loads;
 *  - single-flight: one load per process, the others await its promise;
 *  - lock: single-flight, and one load across processes (a lock in Redis).
 * The application always runs `lock`; the others exist to be measured against it
 * (pnpm db:explain:cache).
 */
export type StampedeProtection = 'none' | 'single-flight' | 'lock';

export interface CacheEntry<T> {
  /** What is invalidated together, tenant included: `catalog:<workspaceId>`. */
  namespace: string;
  key: string;
  /** Before jitter; 0 or less reads past the cache. */
  ttlSeconds: number;
  load: () => Promise<T>;
  /** Turns the parsed JSON back into `T` (dates come back as strings). */
  revive?: (raw: unknown) => T;
  protection?: StampedeProtection;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Calls of `load`: what reached the database. */
  loads: number;
  lockWaits: number;
  errors: number;
}

/** Longer than any load should take: a holder that died frees the key by itself. */
const LOCK_TTL_MS = 5000;
/** How long a caller waits for the lock holder's value before it loads by itself. */
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 50;
/** ±10 %: keys stored in the same second do not expire in the same second. */
const TTL_JITTER = 0.1;
/** Deletes the lock only while it is still ours: after LOCK_TTL_MS it may be someone else's. */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/**
 * Cache-aside on Redis (docs/adr/0010-catalog-cache.md).
 *
 * Invalidation is a version per namespace, not a DEL per key: the version is part of every
 * key, `invalidate` increments it, and the old keys are never read again and expire. One
 * INCR covers a product and every list page, and a reader that loaded before the change and
 * stores after it writes under the old version.
 *
 * A fill reads the primary: what it reads is stored, and a replica that has not replayed the
 * change yet would put the old row back for the whole TTL, for everyone.
 *
 * Redis not answering never fails a read: the caller gets the value from the database.
 */
@Injectable()
export class RedisCache {
  private readonly log: Logger;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly counters: CacheStats = { hits: 0, misses: 0, loads: 0, lockWaits: 0, errors: 0 };

  constructor(
    private readonly redis: RedisService,
    private readonly source: ReadSource,
    @Inject(cacheConfig.KEY) private readonly config: CacheConfig,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: RedisCache.name });
  }

  async getOrLoad<T>(entry: CacheEntry<T>): Promise<T> {
    if (entry.ttlSeconds <= 0) return entry.load();

    let valueKey: string;
    try {
      valueKey = await this.valueKey(entry.namespace, entry.key);
      const cached = await this.read(valueKey, entry.revive);
      if (cached) {
        this.counters.hits += 1;
        return cached.value;
      }
    } catch (error) {
      this.failed('read', error);
      this.counters.loads += 1;
      return entry.load();
    }
    this.counters.misses += 1;

    const protection = entry.protection ?? 'lock';
    if (protection === 'none') return this.fill(entry, valueKey);
    const load = () =>
      protection === 'lock' ? this.fillUnderLock(entry, valueKey) : this.fill(entry, valueKey);
    return this.singleFlight(valueKey, load);
  }

  /** Never throws: a write that succeeded must not fail on its cache. */
  async invalidate(namespace: string): Promise<void> {
    try {
      await this.redis.incr(this.versionKey(namespace));
    } catch (error) {
      this.failed(`invalidate ${namespace}, stale until the keys expire`, error);
    }
  }

  stats(): CacheStats {
    return { ...this.counters };
  }

  private versionKey(namespace: string): string {
    return `${this.config.prefix}:${namespace}:ver`;
  }

  private async valueKey(namespace: string, key: string): Promise<string> {
    const version = (await this.redis.get(this.versionKey(namespace))) ?? '0';
    return `${namespace}:v${version}:${key}`;
  }

  private async read<T>(
    valueKey: string,
    revive: CacheEntry<T>['revive'],
  ): Promise<{ value: T } | undefined> {
    const raw = await this.redis.get(`${this.config.prefix}:${valueKey}`);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return { value: revive ? revive(parsed) : (parsed as T) };
  }

  private async singleFlight<T>(valueKey: string, load: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(valueKey);
    if (running) return running as Promise<T>;
    const promise = load().finally(() => this.inFlight.delete(valueKey));
    this.inFlight.set(valueKey, promise);
    return promise;
  }

  private async fillUnderLock<T>(entry: CacheEntry<T>, valueKey: string): Promise<T> {
    const lockKey = `${this.config.prefix}:lock:${valueKey}`;
    const token = randomUUID();
    let acquired: boolean;
    try {
      acquired = (await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
    } catch (error) {
      this.failed('lock', error);
      return this.fill(entry, valueKey);
    }

    if (!acquired) {
      this.counters.lockWaits += 1;
      const stored = await this.waitForValue(valueKey, entry.revive);
      // nothing came: the holder died or is slower than we wait
      return stored ? stored.value : this.fill(entry, valueKey);
    }

    try {
      // another process may have filled the key between our miss and our lock
      const stored = await this.read(valueKey, entry.revive).catch(() => undefined);
      return stored ? stored.value : await this.fill(entry, valueKey);
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => undefined);
    }
  }

  private async waitForValue<T>(
    valueKey: string,
    revive: CacheEntry<T>['revive'],
  ): Promise<{ value: T } | undefined> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_MS);
      try {
        const stored = await this.read(valueKey, revive);
        if (stored) return stored;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async fill<T>(entry: CacheEntry<T>, valueKey: string): Promise<T> {
    this.source.requirePrimary();
    this.counters.loads += 1;
    const value = await entry.load();
    try {
      await this.redis.set(
        `${this.config.prefix}:${valueKey}`,
        JSON.stringify(value),
        'EX',
        withJitter(entry.ttlSeconds),
      );
    } catch (error) {
      this.failed('store', error);
    }
    return value;
  }

  private failed(what: string, error: unknown): void {
    this.counters.errors += 1;
    this.log.warn({ operation: what, err: error }, 'cache failed, serving from the database');
  }
}

/** `seconds` ±10 %, at least one second. */
export function withJitter(seconds: number, random: () => number = Math.random): number {
  const spread = seconds * TTL_JITTER;
  return Math.max(1, Math.round(seconds - spread + random() * 2 * spread));
}
