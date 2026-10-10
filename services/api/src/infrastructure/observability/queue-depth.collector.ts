import { Inject, Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Queue } from 'bullmq';

import { METRICS, type Metrics, type Sample } from '@shared/observability/metrics';

import type { OnApplicationBootstrap } from '@nestjs/common';

const STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * How many jobs every BullMQ queue of the process holds, by state (ops/observability.md §1).
 * Asked of Redis when the metrics are read. The queues are found, not listed: a module that
 * registers a queue is counted with no line here.
 *
 * In the worker only: the depth is a fact of Redis, and one process reports it.
 */
@Injectable()
export class QueueDepthCollector implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    const queues = this.discovery
      .getProviders()
      .map((wrapper): unknown => wrapper.instance)
      .filter((instance): instance is Queue => instance instanceof Queue);
    this.metrics.gauge({
      name: 'queue_jobs',
      help: 'Jobs a BullMQ queue holds, by state.',
      labels: ['queue', 'state'],
      collect: async () => (await Promise.all(queues.map(depthOf))).flat(),
    });
  }
}

async function depthOf(queue: Queue): Promise<Sample<'queue' | 'state'>[]> {
  const counts = await queue.getJobCounts(...STATES);
  return STATES.map((state) => ({
    labels: { queue: queue.name, state },
    value: counts[state] ?? 0,
  }));
}
