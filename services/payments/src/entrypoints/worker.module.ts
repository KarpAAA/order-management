import { Module } from '@nestjs/common';

import { OutboxWorkerModule } from '@infra/outbox/outbox.worker.module';
import { SharedModule } from '@infra/shared.module';

import { PaymentsWorkerModule } from '@modules/payments';

/**
 * The only process of the service: it consumes commands and relays its outbox.
 * Imports only (ops/process-model.md §2).
 */
@Module({
  imports: [SharedModule, PaymentsWorkerModule, OutboxWorkerModule],
})
export class WorkerModule {}
