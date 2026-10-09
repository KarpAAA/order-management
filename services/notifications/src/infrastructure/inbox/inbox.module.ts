import { Global, Module } from '@nestjs/common';

import { INBOX } from '@shared/messaging/inbox';

import { PostgresInbox } from './postgres-inbox';

/**
 * The inbox: recording a handled message in the transaction of what it caused. Inert: the
 * cleanup of old rows starts in `inbox.worker.module.ts`.
 */
@Global()
@Module({
  providers: [{ provide: INBOX, useClass: PostgresInbox }],
  exports: [INBOX],
})
export class InboxModule {}
