// transport · worker
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { QueueDepthCollector } from './queue-depth.collector';

/**
 * What is measured once for the whole service and not once per process: the depth of the
 * BullMQ queues. In the worker, which is where the queues are worked off.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [QueueDepthCollector],
})
export class ObservabilityWorkerModule {}
