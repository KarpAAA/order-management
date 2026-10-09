// transport · worker
import { Module } from '@nestjs/common';

import { OutboxCleanup } from './outbox-cleanup';
import { OutboxCleanupRunner } from './outbox-cleanup.runner';
import { OUTBOX_PUBLISHER } from './outbox-publisher.port';
import { OutboxRelay } from './outbox-relay';
import { OutboxRelayRunner } from './outbox-relay.runner';
import { RabbitOutboxPublisher } from './rabbit-outbox.publisher';

/**
 * What works on the outbox on its own: the relay that publishes its rows, and the cleanup of
 * the published ones. Both are timers of this process: the service has no job queue.
 */
@Module({
  providers: [
    { provide: OUTBOX_PUBLISHER, useClass: RabbitOutboxPublisher },
    OutboxRelay,
    OutboxRelayRunner,
    OutboxCleanup,
    OutboxCleanupRunner,
  ],
})
export class OutboxWorkerModule {}
