import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { rabbitConfig } from '@config/configuration';
import { LOGGER } from '@shared/logger/logger';

import { connectRabbit } from './rabbit-connection';
import { RabbitSubscribers } from './rabbit-subscribers';

/**
 * The broker connection of the process. A module publishes through `AmqpConnection` from an
 * adapter of its own port, and consumes with `@RabbitSubscribe` in a `*.consumer.ts` of its
 * worker module.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: AmqpConnection, inject: [rabbitConfig.KEY, LOGGER], useFactory: connectRabbit },
    RabbitSubscribers,
  ],
  exports: [AmqpConnection],
})
export class MessagingModule {}
