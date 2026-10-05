import { Module } from '@nestjs/common';

import { RedisModule } from '../redis/redis.module';

import { RedisCache } from './redis-cache';

@Module({
  imports: [RedisModule],
  providers: [RedisCache],
  exports: [RedisCache],
})
export class RedisCacheModule {}
