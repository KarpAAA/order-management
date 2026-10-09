import { Module } from '@nestjs/common';

import { InboxWorkerModule } from '@infra/inbox/inbox.worker.module';
import { OutboxWorkerModule } from '@infra/outbox/outbox.worker.module';
import { SharedModule } from '@infra/shared.module';

import { InventoryWorkerModule } from '@modules/inventory';

/**
 * The only process of the service: it consumes commands, relays its outbox and cleans its
 * inbox. Imports only (ops/process-model.md §2).
 */
@Module({
  imports: [SharedModule, InventoryWorkerModule, OutboxWorkerModule, InboxWorkerModule],
})
export class WorkerModule {}
