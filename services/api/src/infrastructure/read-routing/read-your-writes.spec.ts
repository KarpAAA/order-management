import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DatabaseConfig } from '@config/configuration';
import type { PrismaService } from '@infra/database/prisma.service';
import type { ReplicaPrismaService } from '@infra/database/replica-prisma.service';
import type { RedisService } from '@infra/redis/redis.service';

import { ReadYourWrites } from './read-your-writes';

const USER = 'user-1';
const config = { readYourWritesTtlSeconds: 60 } as DatabaseConfig;

type Answer<T> = T | Error;
const answer = <T>(value: Answer<T>): Promise<T> =>
  value instanceof Error ? Promise.reject(value) : Promise.resolve(value);

/** In-memory stand-ins for Redis and the two databases; `Error` values make a call fail. */
function setup(opts: {
  marker?: Answer<string | null>;
  primaryLsn?: Answer<string>;
  replayed?: Answer<boolean>;
  redisWrite?: Error;
}) {
  const stored: { key: string; value: string; ttl: number }[] = [];
  const redis = {
    get: () => answer(opts.marker ?? null),
    set: (key: string, value: string, _mode: 'EX', ttl: number) => {
      if (opts.redisWrite) return Promise.reject(opts.redisWrite);
      stored.push({ key, value, ttl });
      return Promise.resolve('OK');
    },
  } as unknown as RedisService;
  const primary = {
    $queryRaw: () => answer(opts.primaryLsn ?? '0/0').then((lsn) => [{ lsn }]),
  } as unknown as PrismaService;
  const asked: string[] = [];
  const replica = {
    client: {
      $queryRaw: (_sql: TemplateStringsArray, position: string) => {
        asked.push(position);
        return answer(opts.replayed ?? true).then((replayed) => [{ replayed }]);
      },
    },
  } as unknown as ReplicaPrismaService;
  return { readYourWrites: new ReadYourWrites(primary, replica, redis, config), stored, asked };
}

beforeAll(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('ReadYourWrites.replicaIsCurrentFor (RPL-002, RPL-006)', () => {
  it('lets a user with no marker read the replica, without asking the replica', async () => {
    const { readYourWrites, asked } = setup({ marker: null });

    expect(await readYourWrites.replicaIsCurrentFor(USER)).toBe(true);
    expect(asked).toEqual([]);
  });

  it.each([
    { replayed: true, current: true },
    { replayed: false, current: false },
  ])('asks the replica about the marked position: replayed=$replayed', async (c) => {
    const { readYourWrites, asked } = setup({ marker: '4/F000060', replayed: c.replayed });

    expect(await readYourWrites.replicaIsCurrentFor(USER)).toBe(c.current);
    expect(asked).toEqual(['4/F000060']);
  });

  it('keeps a pinned user on the primary, without asking the replica', async () => {
    const { readYourWrites, asked } = setup({ marker: 'pinned' });

    expect(await readYourWrites.replicaIsCurrentFor(USER)).toBe(false);
    expect(asked).toEqual([]);
  });

  it('reads the replica when Redis does not answer', async () => {
    const { readYourWrites } = setup({ marker: new Error('redis down') });

    expect(await readYourWrites.replicaIsCurrentFor(USER)).toBe(true);
  });

  it('reads the primary when the replica does not answer the position check', async () => {
    const { readYourWrites } = setup({ marker: '4/F000060', replayed: new Error('replica down') });

    expect(await readYourWrites.replicaIsCurrentFor(USER)).toBe(false);
  });
});

describe('ReadYourWrites.recordWrite (RPL-002, RPL-006)', () => {
  it("stores the primary's position for the user, with the configured TTL", async () => {
    const { readYourWrites, stored } = setup({ primaryLsn: '4/F000060' });

    await readYourWrites.recordWrite(USER);

    expect(stored).toEqual([{ key: `ryw:${USER}`, value: '4/F000060', ttl: 60 }]);
  });

  it('pins the user to the primary when the position cannot be read', async () => {
    const { readYourWrites, stored } = setup({ primaryLsn: new Error('primary busy') });

    await readYourWrites.recordWrite(USER);

    expect(stored).toEqual([{ key: `ryw:${USER}`, value: 'pinned', ttl: 60 }]);
  });

  it('does not fail the request when Redis refuses the marker', async () => {
    const { readYourWrites } = setup({ redisWrite: new Error('redis down') });

    await expect(readYourWrites.recordWrite(USER)).resolves.toBeUndefined();
  });
});
