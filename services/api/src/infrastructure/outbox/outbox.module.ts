import { Global, Module } from '@nestjs/common';

import { Outbox } from './outbox';
import { ReliableEvents } from './reliable-events';

/**
 * The write side of the outbox, for every process: appending a message in the current
 * transaction and the translations of reliable events. Inert: what publishes the rows
 * starts in `outbox.worker.module.ts`.
 */
@Global()
@Module({
  providers: [Outbox, ReliableEvents],
  exports: [Outbox, ReliableEvents],
})
export class OutboxModule {}
