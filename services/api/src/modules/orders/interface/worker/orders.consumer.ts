import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { TenantContext } from '@common/tenancy/tenant-context';
import { ordersQueueConfig, type OrdersQueueConfig } from '@config/configuration';
import { systemActor } from '@shared/auth/actor';
import { InvalidStateError } from '@shared/errors/domain-error';
import { InfrastructureError } from '@shared/errors/infrastructure-error';

import { ProcessOrderPaymentService } from '../../application/process-order-payment.service';
import { ORDERS_QUEUE, type OrdersJobs } from '../../infrastructure/orders.queue';

import { MaintainOrderEventPartitionsJob } from './maintain-order-event-partitions.job';

import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';

const ACTOR = systemActor('consumer:orders');

/**
 * Thin: route by job name, bind the tenant from the job, build the actor, call one use case
 * or one cron job's `run()`.
 * Concurrency comes from config via the worker module (`ORDERS_WORKER_CONCURRENCY`).
 */
@Processor(ORDERS_QUEUE)
export class OrdersConsumer extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersConsumer.name);

  constructor(
    private readonly tenant: TenantContext,
    private readonly processPayment: ProcessOrderPaymentService,
    private readonly partitionsJob: MaintainOrderEventPartitionsJob,
    @Inject(ordersQueueConfig.KEY) private readonly config: OrdersQueueConfig,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.concurrency;
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'charge-order':
        return this.charge(job as Job<OrdersJobs['charge-order']>);
      case MaintainOrderEventPartitionsJob.QUEUE_JOB:
        // no workspace: partitions belong to the table, not to a tenant
        return this.partitionsJob.run();
      default:
        throw new UnrecoverableError(`unknown job ${job.name}`);
    }
  }

  private async charge(job: Job<OrdersJobs['charge-order']>): Promise<void> {
    const { workspaceId, orderId, paymentAttempt } = job.data;
    const maxAttempts = job.opts.attempts ?? 1;
    try {
      await this.tenant.runInWorkspace(workspaceId, () =>
        this.processPayment.execute(
          { orderId, paymentAttempt, isFinalAttempt: job.attemptsMade + 1 >= maxAttempts },
          ACTOR,
        ),
      );
    } catch (err: unknown) {
      if (err instanceof InvalidStateError) {
        // Already settled, or a stale attempt: done, not failed (idempotent replay).
        this.logger.log(`job ${job.id ?? ''} skipped: ${err.code}`);
        return;
      }
      if (err instanceof InfrastructureError && !err.retryable) {
        // a bad request or key: retrying cannot help, straight to failed (queues.md §3)
        throw new UnrecoverableError(err.message);
      }
      this.logger.warn(
        `job ${job.id ?? ''} attempt ${job.attemptsMade + 1}/${maxAttempts} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err; // BullMQ applies attempts + exponential backoff
    }
  }

  /**
   * A dead job is a bug (transient PSP failures end as PAYMENT_FAILED). This event fires on
   * every failed attempt; dead = attempts spent, or failed for good by UnrecoverableError after
   * fewer attempts (queues.md §4).
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    const attemptsSpent = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (attemptsSpent || err.name === 'UnrecoverableError') {
      this.logger.error(`dead job ${job.name} id=${job.id ?? ''}: ${err.message}`);
    }
  }
}
