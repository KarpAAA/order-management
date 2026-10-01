import { Inject, Injectable, Logger } from '@nestjs/common';

import { orderEventsConfig, type OrderEventsConfig } from '@config/configuration';
import { systemActor } from '@shared/auth/actor';

import { MaintainOrderEventPartitionsService } from '../../application/maintain-order-event-partitions.service';

import type { OrdersCronJobName } from '../../infrastructure/orders.queue';

/**
 * Daily: keeps the `order_events` partitions of the coming months ready and drops the ones past
 * the retention. One unit of work, so it calls the use case directly (transport/cron.md §1).
 * `run()` has no trigger of its own: the worker module registers the schedule, the consumer
 * calls it.
 */
@Injectable()
export class MaintainOrderEventPartitionsJob {
  static readonly NAME = 'maintain-order-event-partitions';
  static readonly QUEUE_JOB = 'cron:maintain-order-event-partitions' satisfies OrdersCronJobName;
  // 03:00 UTC every day, the same in every environment: the work is idempotent and takes
  // milliseconds; daily means one failed run costs nothing with months of partitions ahead
  static readonly SCHEDULE = '0 3 * * *';

  private readonly logger = new Logger(MaintainOrderEventPartitionsJob.name);
  private readonly actor = systemActor(`job:${MaintainOrderEventPartitionsJob.NAME}`);

  constructor(
    private readonly maintain: MaintainOrderEventPartitionsService,
    @Inject(orderEventsConfig.KEY) private readonly config: OrderEventsConfig,
  ) {}

  async run(): Promise<void> {
    const job = MaintainOrderEventPartitionsJob.NAME;
    if (!this.config.partitionsEnabled) {
      this.logger.warn(`${job} skipped: ORDER_EVENTS_PARTITIONS_ENABLED=false`);
      return;
    }
    const startedAt = performance.now();
    this.logger.log(`${job} started`);
    try {
      const { created, dropped } = await this.maintain.execute(
        { monthsAhead: this.config.partitionsAhead, retentionMonths: this.config.retentionMonths },
        this.actor,
      );
      this.logger.log(
        `${job} finished: created=${String(created)} dropped=${String(dropped)} ` +
          `durationMs=${String(Math.round(performance.now() - startedAt))}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `${job} failed after ${String(Math.round(performance.now() - startedAt))} ms: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      throw err; // the queue retries; the consumer alerts on a dead job
    }
  }
}
