import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { JobScope } from '@common/messaging/job-scope';
import { ordersQueueConfig, type OrdersQueueConfig } from '@config/configuration';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { ORDERS_QUEUE } from '../../infrastructure/orders.queue';

import { MaintainOrderEventPartitionsJob } from './maintain-order-event-partitions.job';

import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';

/**
 * Thin: route by job name, call one cron job's `run()`. The queue carries scheduler ticks
 * only; payment outcomes arrive through the broker (`payment-events.consumer.ts`).
 * Concurrency comes from config via the worker module (`ORDERS_WORKER_CONCURRENCY`).
 */
@Processor(ORDERS_QUEUE)
export class OrdersConsumer extends WorkerHost implements OnApplicationBootstrap {
  private readonly log: Logger;

  constructor(
    private readonly partitionsJob: MaintainOrderEventPartitionsJob,
    @Inject(ordersQueueConfig.KEY) private readonly config: OrdersQueueConfig,
    private readonly jobs: JobScope,
    @Inject(LOGGER) logger: Logger,
  ) {
    super();
    this.log = logger.child({ context: OrdersConsumer.name });
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.concurrency;
  }

  process(job: Job): Promise<void> {
    return this.jobs.run(job, () => this.route(job));
  }

  private async route(job: Job): Promise<void> {
    switch (job.name) {
      case MaintainOrderEventPartitionsJob.QUEUE_JOB:
        // no workspace: partitions belong to the table, not to a tenant
        return this.partitionsJob.run();
      default:
        throw new UnrecoverableError(`unknown job ${job.name}`);
    }
  }

  /**
   * A dead job is a bug. This event fires on every failed attempt; dead = attempts spent, or
   * failed for good by UnrecoverableError after fewer attempts (queues.md §4).
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    const attemptsSpent = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (attemptsSpent || err.name === 'UnrecoverableError') {
      this.log.error({ queue: job.queueName, job: job.name, jobId: job.id, err }, 'dead job');
    }
  }
}
