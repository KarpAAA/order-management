// transport · worker
import { Module } from '@nestjs/common';

import { OrdersQueue } from './infrastructure/orders.queue';
import { MaintainOrderEventPartitionsJob } from './interface/worker/maintain-order-event-partitions.job';
import { OrdersConsumer } from './interface/worker/orders.consumer';
import { OrdersModule } from './orders.module';

import type { OnApplicationBootstrap } from '@nestjs/common';

@Module({
  imports: [OrdersModule],
  providers: [OrdersConsumer, MaintainOrderEventPartitionsJob],
})
export class OrdersWorkerModule implements OnApplicationBootstrap {
  constructor(private readonly queue: OrdersQueue) {}

  /** Cron schedules are a startup side effect, so they live here (transport/cron.md §2). */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertScheduler(
      MaintainOrderEventPartitionsJob.NAME,
      MaintainOrderEventPartitionsJob.QUEUE_JOB,
      MaintainOrderEventPartitionsJob.SCHEDULE,
    );
  }
}
