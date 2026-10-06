import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';

import type { JobsOptions, Queue } from 'bullmq';

/** One queue per module (transport/queues.md §1); the job name is the operation. */
export const ORDERS_QUEUE = 'orders';

/**
 * Only scheduler ticks are left here: a charge is a command to payments-service, sent through
 * the broker (`rabbit-payment-charge.adapter.ts`).
 */
export interface OrdersJobs {
  /** A scheduler tick: no payload, the job class decides what to do (transport/cron.md §2). */
  'cron:maintain-order-event-partitions': Record<string, never>;
}

export type OrdersJobName = keyof OrdersJobs;
export type OrdersCronJobName = Extract<OrdersJobName, `cron:${string}`>;

const CRON_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
};

/** Producer. Retention defaults are set at queue registration. */
@Injectable()
export class OrdersQueue {
  constructor(@InjectQueue(ORDERS_QUEUE) private readonly queue: Queue) {}

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
