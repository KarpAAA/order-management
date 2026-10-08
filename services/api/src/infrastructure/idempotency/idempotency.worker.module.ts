// transport · worker
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CleanupIdempotencyKeysJob } from './cleanup-idempotency-keys.job';
import { IdempotencyCleanup } from './idempotency-cleanup';
import { IdempotencyConsumer } from './idempotency.consumer';
import { IDEMPOTENCY_QUEUE, IdempotencyQueue } from './idempotency.queue';

import type { OnApplicationBootstrap } from '@nestjs/common';

/**
 * What works on the idempotency keys on its own: the hourly cleanup. In the worker process,
 * although the api process fills the table: scheduled work lives in the worker
 * (ops/process-model.md). The queue is registered here as well: nothing outside this module
 * puts a job on it.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: IDEMPOTENCY_QUEUE,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
    }),
  ],
  providers: [IdempotencyCleanup, IdempotencyQueue, IdempotencyConsumer, CleanupIdempotencyKeysJob],
})
export class IdempotencyWorkerModule implements OnApplicationBootstrap {
  constructor(private readonly queue: IdempotencyQueue) {}

  /** Cron schedules are a startup side effect, so they live here (transport/cron.md §2). */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertScheduler(
      CleanupIdempotencyKeysJob.NAME,
      CleanupIdempotencyKeysJob.QUEUE_JOB,
      CleanupIdempotencyKeysJob.SCHEDULE,
    );
  }
}
