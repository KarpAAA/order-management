import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { RedisModule } from '../redis/redis.module';

import { ReadRoutingInterceptor } from './read-routing.interceptor';
import { ReadYourWrites } from './read-your-writes';

/**
 * Routes the reads of HTTP requests between the primary and the read replica. Inert in the
 * worker, which serves no HTTP: its reads stay on the primary.
 */
@Module({
  imports: [RedisModule],
  providers: [ReadYourWrites, { provide: APP_INTERCEPTOR, useClass: ReadRoutingInterceptor }],
})
export class ReadRoutingModule {}
