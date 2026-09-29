import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { redisConfig, type RedisConfig } from '@config/configuration';

/** Shared BullMQ connection. Queues are registered by the module that owns them. */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      // `prefix` applies to every queue and worker of the process (BullMQ's default is `bull`)
      useFactory: (redis: RedisConfig) => ({
        connection: { url: redis.url },
        prefix: redis.queuePrefix,
      }),
    }),
  ],
})
export class QueuesModule {}
