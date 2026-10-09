// transport · worker
import { Module } from '@nestjs/common';

import { CleanupNotificationsJob } from './interface/worker/cleanup-notifications.job';
import { DispatchNotificationsJob } from './interface/worker/dispatch-notifications.job';
import { OrderEventsConsumer } from './interface/worker/order-events.consumer';
import { NotificationsModule } from './notifications.module';

/** What works on its own: the consumer of order events, the dispatcher, the cleanup. */
@Module({
  imports: [NotificationsModule],
  providers: [OrderEventsConsumer, DispatchNotificationsJob, CleanupNotificationsJob],
})
export class NotificationsWorkerModule {}
