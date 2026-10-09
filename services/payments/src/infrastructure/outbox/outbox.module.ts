import { Global, Module } from '@nestjs/common';

import { Outbox } from './outbox';

/**
 * The write side of the outbox: appending a message in the current transaction. Inert: what
 * publishes the rows starts in `outbox.worker.module.ts`.
 */
@Global()
@Module({
  providers: [Outbox],
  exports: [Outbox],
})
export class OutboxModule {}
