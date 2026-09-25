import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';

import type {
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../ports/payment-charge-scheduler.port';
import type { Queue } from 'bullmq';

/** One queue per module (transport/queues.md §1); the job name is the operation. */
export const ORDERS_QUEUE = 'orders';

export interface OrdersJobs {
  'charge-order': { workspaceId: string; orderId: string; paymentAttempt: number };
}

export type OrdersJobName = keyof OrdersJobs;

/**
 * Deterministic id: BullMQ drops a duplicate while the first is pending or active, so the
 * same attempt is never enqueued twice. `-` instead of the spec's `:` because BullMQ 6
 * rejects `:` in custom ids (it survives only through a legacy compatibility branch).
 */
const jobIdFor = <N extends OrdersJobName>(_name: N, data: OrdersJobs[N]): string =>
  `charge-${data.orderId}-${data.paymentAttempt}`;

/** Producer. Defaults (attempts, backoff, retention) are set at queue registration. */
@Injectable()
export class OrdersQueue implements PaymentChargeScheduler {
  constructor(@InjectQueue(ORDERS_QUEUE) private readonly queue: Queue) {}

  async add<N extends OrdersJobName>(name: N, data: OrdersJobs[N]): Promise<void> {
    await this.queue.add(name, data, { jobId: jobIdFor(name, data) });
  }

  schedule(charge: ScheduledCharge): Promise<void> {
    return this.add('charge-order', charge);
  }
}
