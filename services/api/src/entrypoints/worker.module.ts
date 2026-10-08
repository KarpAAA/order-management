import { Module } from '@nestjs/common';

import { IdempotencyWorkerModule } from '@infra/idempotency/idempotency.worker.module';
import { InboxWorkerModule } from '@infra/inbox/inbox.worker.module';
import { OutboxWorkerModule } from '@infra/outbox/outbox.worker.module';
import { SharedModule } from '@infra/shared.module';

import { OrdersWorkerModule } from '@modules/orders';

/**
 * The worker process: queue and broker consumers, cron, the relay of the outbox, the cleanup
 * of the inbox. Imports only (ops/process-model.md §2).
 */
@Module({
  imports: [
    SharedModule,
    OrdersWorkerModule,
    OutboxWorkerModule,
    InboxWorkerModule,
    IdempotencyWorkerModule,
  ],
})
export class WorkerModule {}
