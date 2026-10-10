// transport · worker
import { Module } from '@nestjs/common';

import { ConsumerScope } from './infrastructure/consumer-scope';
import { OrdersQueue } from './infrastructure/orders.queue';
import { InventoryEventsConsumer } from './interface/worker/inventory-events.consumer';
import { MaintainOrderEventPartitionsJob } from './interface/worker/maintain-order-event-partitions.job';
import { OrdersConsumer } from './interface/worker/orders.consumer';
import { PaymentEventsConsumer } from './interface/worker/payment-events.consumer';
import { SagaTimeoutsConsumer } from './interface/worker/saga-timeouts.consumer';
import { OrdersModule } from './orders.module';

import type { OnApplicationBootstrap } from '@nestjs/common';

@Module({
  imports: [OrdersModule],
  // the queue (cron ticks) and the broker: what moves the saga of an order, which is the
  // answers of inventory-service and payments-service and the timeouts of its steps
  providers: [
    OrdersConsumer,
    MaintainOrderEventPartitionsJob,
    ConsumerScope,
    InventoryEventsConsumer,
    PaymentEventsConsumer,
    SagaTimeoutsConsumer,
  ],
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
