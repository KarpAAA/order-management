import { Module } from '@nestjs/common';

import { SharedModule } from '@infra/shared.module';

import { PaymentsWorkerModule } from '@modules/payments';

/** The only process of the service: it consumes commands. Imports only (ops/process-model.md §2). */
@Module({
  imports: [SharedModule, PaymentsWorkerModule],
})
export class WorkerModule {}
