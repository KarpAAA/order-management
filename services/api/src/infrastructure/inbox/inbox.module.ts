import { Global, Module } from '@nestjs/common';

import { INBOX } from '@shared/messaging/inbox';

import { PostgresInbox } from './postgres-inbox';

/**
 * The inbox, for every process: recording a handled message in the current transaction.
 * Inert: the cleanup of old rows starts in `inbox.worker.module.ts`.
 */
@Global()
@Module({
  providers: [{ provide: INBOX, useClass: PostgresInbox }],
  exports: [INBOX],
})
export class InboxModule {}
