import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { redisConfig, type RedisConfig } from '@config/configuration';

import type { OnModuleDestroy } from '@nestjs/common';

/**
 * The Redis client of the process for everything that is not a queue (BullMQ keeps its own
 * connections, queues.module.ts). A command fails fast instead of waiting for Redis to come
 * back: its callers are on the request path and have an answer for "Redis is down".
 */
@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor(@Inject(redisConfig.KEY) config: RedisConfig) {
    // lazy: a process that never asks (the worker, an api without a replica) opens nothing
    super(config.url, { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 500 });
    // without a listener ioredis prints every reconnect attempt as an unhandled error event
    this.on('error', () => undefined);
  }

  onModuleDestroy(): void {
    this.disconnect();
  }
}
