import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LATER, ORDER, WORKSPACE } from '../../domain/__test__/builders';
import { OrderPlaced } from '../../domain/events/order-placed.event';

import { SchedulePaymentChargeHandler } from './schedule-payment-charge.handler';

import type {
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../../ports/payment-charge-scheduler.port';

/** Spy scheduler: records what was scheduled, or fails like Redis being down. */
class RecordingScheduler implements PaymentChargeScheduler {
  readonly scheduled: ScheduledCharge[] = [];

  constructor(private readonly failure?: Error) {}

  schedule(charge: ScheduledCharge): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.scheduled.push(charge);
    return Promise.resolve();
  }
}

describe('SchedulePaymentChargeHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PAY-001 schedules the charge of the placed attempt in its workspace', async () => {
    const scheduler = new RecordingScheduler();

    await new SchedulePaymentChargeHandler(scheduler).handle(
      new OrderPlaced(WORKSPACE, ORDER, 2, LATER),
    );

    expect(scheduler.scheduled).toEqual([
      { workspaceId: WORKSPACE, orderId: ORDER, paymentAttempt: 2 },
    ]);
  });

  it('logs a failed enqueue instead of throwing: the order is already committed (known gap)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const handler = new SchedulePaymentChargeHandler(
      new RecordingScheduler(new Error('redis down')),
    );

    await expect(
      handler.handle(new OrderPlaced(WORKSPACE, ORDER, 1, LATER)),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      `failed to enqueue charge orderId=${ORDER} attempt=1`,
      expect.stringContaining('redis down'),
    );
  });
});
