import { Global, Module } from '@nestjs/common';

import { CorrelationContext } from '@common/messaging/correlation-context';

import { Outbox } from './outbox';
import { ReliableEvents } from './reliable-events';

/**
 * The write side of the outbox, for every process: appending a message in the current
 * transaction, the translations of reliable events, the correlation id. Inert: what
 * publishes the rows starts in `outbox.worker.module.ts`.
 */
@Global()
@Module({
  providers: [Outbox, ReliableEvents, CorrelationContext],
  exports: [Outbox, ReliableEvents, CorrelationContext],
})
export class OutboxModule {}
