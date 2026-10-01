import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderEventsConfig } from '@config/configuration';

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
): MaintainOrderEventPartitionsJob {
  return new MaintainOrderEventPartitionsJob(
    { execute } as MaintainOrderEventPartitionsService,
    config(overrides),
  );
}

describe('MaintainOrderEventPartitionsJob.run (transport/cron.md)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the use case with the configured window, as its own system actor', async () => {
    const execute = vi.fn().mockResolvedValue({ created: 1, dropped: 0 });

    await jobWith(execute).run();

    expect(execute).toHaveBeenCalledWith(
      { monthsAhead: 3, retentionMonths: 6 },
      { kind: 'system', source: 'job:maintain-order-event-partitions' },
    );
  });

  it('logs the start and the outcome with the counts', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');

    await jobWith(vi.fn().mockResolvedValue({ created: 2, dropped: 1 })).run();

    expect(log).toHaveBeenCalledWith('maintain-order-event-partitions started');
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^maintain-order-event-partitions finished: created=2 dropped=1 durationMs=\d+$/,
      ),
    );
  });

  it('does nothing when it is switched off', async () => {
    const execute = vi.fn();

    await jobWith(execute, { partitionsEnabled: false }).run();

    expect(execute).not.toHaveBeenCalled();
  });

  it('logs a failure and rethrows it: the queue retries, nothing is swallowed', async () => {
    const error = new Error('no partition for 2026-11');
    const alert = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(jobWith(vi.fn().mockRejectedValue(error)).run()).rejects.toBe(error);

    expect(alert).toHaveBeenCalledWith(expect.stringContaining('no partition for 2026-11'));
  });
});
