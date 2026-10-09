// transport · worker
import { Module } from '@nestjs/common';

import { InboxCleanup } from './inbox-cleanup';
import { InboxCleanupRunner } from './inbox-cleanup.runner';

/** What works on the inbox on its own: the cleanup of old rows, a timer of this process. */
@Module({
  providers: [InboxCleanup, InboxCleanupRunner],
})
export class InboxWorkerModule {}
