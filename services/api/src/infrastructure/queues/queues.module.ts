import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { redisConfig, type RedisConfig } from '@config/configuration';

/** Shared BullMQ connection. Queues are registered by the module that owns them. */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (redis: RedisConfig) => ({ connection: { url: redis.url } }),
    }),
  ],
})
export class QueuesModule {}
