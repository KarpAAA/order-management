import { Global, Module } from '@nestjs/common';

import { Inbox } from './inbox';

/**
 * The inbox: recording a handled message in the current transaction. Inert: the cleanup of
 * old rows starts in `inbox.worker.module.ts`.
 */
@Global()
@Module({
  providers: [Inbox],
  exports: [Inbox],
})
export class InboxModule {}
