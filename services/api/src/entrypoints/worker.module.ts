import { Module } from '@nestjs/common';

import { SharedModule } from '@infra/shared.module';

import { OrdersWorkerModule } from '@modules/orders';

/** The queue-consumer process. Imports only (ops/process-model.md §2). */
@Module({
  imports: [SharedModule, OrdersWorkerModule],
})
export class WorkerModule {}
