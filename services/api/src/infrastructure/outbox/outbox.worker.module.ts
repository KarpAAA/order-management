// transport · worker
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CleanupOutboxJob } from './cleanup-outbox.job';
import { OutboxCleanup } from './outbox-cleanup';
import { OUTBOX_PUBLISHER } from './outbox-publisher.port';
import { OutboxRelay } from './outbox-relay';
import { OutboxRelayRunner } from './outbox-relay.runner';
import { OutboxConsumer } from './outbox.consumer';
import { OutboxMetrics } from './outbox.metrics';
import { OUTBOX_QUEUE, OutboxQueue } from './outbox.queue';
import { RabbitOutboxPublisher } from './rabbit-outbox.publisher';

import type { OnApplicationBootstrap } from '@nestjs/common';

/**
 * What works on the outbox on its own: the relay that publishes its rows, and the daily
 * cleanup. In the worker process only: an api replica writes rows and never publishes them.
 * The queue is registered here as well: nothing outside this module puts a job on it.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: OUTBOX_QUEUE,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
    }),
  ],
  providers: [
    { provide: OUTBOX_PUBLISHER, useClass: RabbitOutboxPublisher },
    OutboxRelay,
    OutboxRelayRunner,
    OutboxMetrics,
    OutboxCleanup,
    OutboxQueue,
    OutboxConsumer,
    CleanupOutboxJob,
  ],
})
export class OutboxWorkerModule implements OnApplicationBootstrap {
  constructor(private readonly queue: OutboxQueue) {}

  /** Cron schedules are a startup side effect, so they live here (transport/cron.md §2). */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertScheduler(
      CleanupOutboxJob.NAME,
      CleanupOutboxJob.QUEUE_JOB,
      CleanupOutboxJob.SCHEDULE,
    );
  }
}
