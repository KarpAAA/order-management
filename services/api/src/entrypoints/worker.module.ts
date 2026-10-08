import { Module } from '@nestjs/common';

import { OutboxWorkerModule } from '@infra/outbox/outbox.worker.module';
import { SharedModule } from '@infra/shared.module';

import { OrdersWorkerModule } from '@modules/orders';

/**
 * The worker process: queue and broker consumers, cron, the relay of the outbox.
 * Imports only (ops/process-model.md §2).
 */
@Module({
  imports: [SharedModule, OrdersWorkerModule, OutboxWorkerModule],
})
export class WorkerModule {}
