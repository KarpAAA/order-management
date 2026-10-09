import { Module } from '@nestjs/common';

import { InboxWorkerModule } from '@infra/inbox/inbox.worker.module';
import { SharedModule } from '@infra/shared.module';

import { NotificationsWorkerModule } from '@modules/notifications';

/**
 * The only process of the service: it consumes the events of orders, sends the notifications
 * they cause and cleans its tables. Imports only (ops/process-model.md §2).
 */
@Module({
  imports: [SharedModule, NotificationsWorkerModule, InboxWorkerModule],
})
export class WorkerModule {}
