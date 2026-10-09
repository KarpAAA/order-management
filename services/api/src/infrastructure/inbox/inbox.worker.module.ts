// transport · worker
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CleanupInboxJob } from './cleanup-inbox.job';
import { InboxCleanup } from './inbox-cleanup';
import { InboxConsumer } from './inbox.consumer';
import { INBOX_QUEUE, InboxQueue } from './inbox.queue';

import type { OnApplicationBootstrap } from '@nestjs/common';

/**
 * What works on the inbox on its own: the daily cleanup. In the worker process only, where
 * the consumers that fill the table run. The queue is registered here as well: nothing
 * outside this module puts a job on it.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: INBOX_QUEUE,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
    }),
  ],
  providers: [InboxCleanup, InboxQueue, InboxConsumer, CleanupInboxJob],
})
export class InboxWorkerModule implements OnApplicationBootstrap {
  constructor(private readonly queue: InboxQueue) {}

  /** Cron schedules are a startup side effect, so they live here (transport/cron.md §2). */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertScheduler(
      CleanupInboxJob.NAME,
      CleanupInboxJob.QUEUE_JOB,
      CleanupInboxJob.SCHEDULE,
    );
  }
}
