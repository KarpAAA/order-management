import { Inject } from '@nestjs/common';

import { UseCase } from '@common/decorators/use-case.decorator';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';

import {
  ORDER_EVENT_PARTITIONS,
  OrderEventPartitionsMissingError,
} from '../ports/order-event-partitions.port';

import { OrdersPolicy } from './orders.policy';
import { planPartitions } from './partition-plan';

import type { MaintainOrderEventPartitionsCommand } from './order-commands';
import type { OrderEventPartitionsPort } from '../ports/order-event-partitions.port';

export interface PartitionMaintenanceResult {
  created: number;
  dropped: number;
}

/**
 * Keeps the order history writable and bounded: creates the partitions of the coming months,
 * drops the ones past the retention. Safe to run any number of times.
 *
 * No `@Transactional()`: the work is DDL, one statement at a time, and detaching a partition
 * concurrently cannot run inside a transaction.
 */
@UseCase()
export class MaintainOrderEventPartitionsService {
  constructor(
    @Inject(ORDER_EVENT_PARTITIONS) private readonly partitions: OrderEventPartitionsPort,
    private readonly policy: OrdersPolicy,
    private readonly clock: Clock,
  ) {}

  async execute(
    cmd: MaintainOrderEventPartitionsCommand,
    actor: Actor,
  ): Promise<PartitionMaintenanceResult> {
    this.policy.assertCanMaintainPartitions(actor);
    const now = this.clock.now();
    const plan = planPartitions({ ...cmd, now, existing: await this.partitions.list() });

    for (const month of plan.create) await this.partitions.create(month);
    await this.assertReady(now, cmd.monthsAhead);
    // only after the coming months are safe: a failed drop must not leave writes at risk
    for (const month of plan.drop) await this.partitions.drop(month);

    return { created: plan.create.length, dropped: plan.drop.length };
  }

  /** A month without a partition rejects writes: fail now, months before it would. */
  private async assertReady(now: Date, monthsAhead: number): Promise<void> {
    const existing = await this.partitions.list();
    const missing = planPartitions({ now, existing, monthsAhead, retentionMonths: 0 }).create;
    if (missing.length > 0) throw new OrderEventPartitionsMissingError(missing);
  }
}
