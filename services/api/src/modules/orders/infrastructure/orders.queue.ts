import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';

import type {
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../ports/payment-charge-scheduler.port';
import type { JobsOptions, Queue } from 'bullmq';

/** One queue per module (transport/queues.md §1); the job name is the operation. */
export const ORDERS_QUEUE = 'orders';

export interface OrdersJobs {
  'charge-order': { workspaceId: string; orderId: string; paymentAttempt: number };
  /** A scheduler tick: no payload, the job class decides what to do (transport/cron.md §2). */
  'cron:maintain-order-event-partitions': Record<string, never>;
}

export type OrdersJobName = keyof OrdersJobs;
export type OrdersCronJobName = Extract<OrdersJobName, `cron:${string}`>;

/**
 * Deterministic id: BullMQ drops a duplicate while the first is pending or active, so the
 * same attempt is never enqueued twice. `-` instead of the spec's `:` because BullMQ 6
 * rejects `:` in custom ids (it survives only through a legacy compatibility branch).
 */
const chargeJobId = (charge: ScheduledCharge): string =>
  `charge-${charge.orderId}-${String(charge.paymentAttempt)}`;

// not the queue defaults: those are the charge retry budget, tuned to the PSP
const CRON_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
};

/** Producer. Defaults (attempts, backoff, retention) are set at queue registration. */
@Injectable()
export class OrdersQueue implements PaymentChargeScheduler {
  constructor(@InjectQueue(ORDERS_QUEUE) private readonly queue: Queue) {}

  async schedule(charge: ScheduledCharge): Promise<void> {
    await this.queue.add('charge-order', charge, { jobId: chargeJobId(charge) });
  }

  /**
   * Registers a repeatable job, or updates its schedule: one scheduler per id in Redis, however
   * many workers start. The first tick runs right away, so a worker that was down for long
   * catches up at boot instead of at the next cron time.
   */
  async upsertScheduler(
    schedulerId: string,
    name: OrdersCronJobName,
    pattern: string,
  ): Promise<void> {
    await this.queue.upsertJobScheduler(
      schedulerId,
      { pattern, immediately: true },
      { name, data: {}, opts: CRON_JOB_OPTIONS },
    );
  }
}
