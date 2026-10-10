import { describe, expect, it, vi } from 'vitest';

import type { OrderEventsConfig } from '@config/configuration';
import { RecordingLogger } from '@shared/logger/__test__/recording-logger';

import { MaintainOrderEventPartitionsJob } from './maintain-order-event-partitions.job';

import type { MaintainOrderEventPartitionsService } from '../../application/maintain-order-event-partitions.service';

const config = (overrides: Partial<OrderEventsConfig> = {}): OrderEventsConfig => ({
  partitionsAhead: 3,
  retentionMonths: 6,
  partitionsEnabled: true,
  ...overrides,
});

function jobWith(
  execute: MaintainOrderEventPartitionsService['execute'],
  overrides: Partial<OrderEventsConfig> = {},
) {
  const logger = new RecordingLogger();
  const job = new MaintainOrderEventPartitionsJob(
    { execute } as MaintainOrderEventPartitionsService,
    config(overrides),
    logger,
  );
  return { job, logger };
}

describe('MaintainOrderEventPartitionsJob.run (transport/cron.md)', () => {
  it('calls the use case with the configured window, as its own system actor', async () => {
    const execute = vi.fn().mockResolvedValue({ created: 1, dropped: 0 });

    await jobWith(execute).job.run();

    expect(execute).toHaveBeenCalledWith(
      { monthsAhead: 3, retentionMonths: 6 },
      { kind: 'system', source: 'job:maintain-order-event-partitions' },
    );
  });

  it('logs the outcome with the counts, as fields', async () => {
    const { job, logger } = jobWith(vi.fn().mockResolvedValue({ created: 2, dropped: 1 }));

    await job.run();

    expect(logger.at('info')).toEqual([
      {
        level: 'info',
        message: 'partitions maintained',
        fields: {
          context: 'MaintainOrderEventPartitionsJob',
          job: 'maintain-order-event-partitions',
          created: 2,
          dropped: 1,
        },
      },
    ]);
  });

  it('does nothing when it is switched off, and says so', async () => {
    const execute = vi.fn();
    const { job, logger } = jobWith(execute, { partitionsEnabled: false });

    await job.run();

    expect(execute).not.toHaveBeenCalled();
    expect(logger.at('warn')).toHaveLength(1);
  });

  it('lets a failure out: the queue retries, and the run is logged by the scope of the job', async () => {
    const error = new Error('no partition for 2026-11');
    const { job, logger } = jobWith(vi.fn().mockRejectedValue(error));

    await expect(job.run()).rejects.toBe(error);

    expect(logger.lines).toEqual([]);
  });
});
