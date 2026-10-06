import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Money } from '@shared/domain/money';

import { CURRENCY, LATER, ORDER, WORKSPACE } from '../../domain/__test__/builders';
import { OrderPlaced } from '../../domain/events/order-placed.event';

import { SchedulePaymentChargeHandler } from './schedule-payment-charge.handler';

import type {
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../../ports/payment-charge-scheduler.port';

const AMOUNT = Money.of(12_50n, CURRENCY);

/** Spy scheduler: records what was scheduled, or fails like the broker being down. */
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

  it('PAY-001 requests the charge of the placed attempt, with its amount, in its workspace', async () => {
    const scheduler = new RecordingScheduler();

    await new SchedulePaymentChargeHandler(scheduler).handle(
      new OrderPlaced(WORKSPACE, ORDER, 2, AMOUNT, LATER),
    );

    expect(scheduler.scheduled).toEqual([
      { workspaceId: WORKSPACE, orderId: ORDER, paymentAttempt: 2, amount: AMOUNT },
    ]);
  });

  it('logs a failed request instead of throwing: the order is already committed (known gap)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const handler = new SchedulePaymentChargeHandler(
      new RecordingScheduler(new Error('broker down')),
    );

    await expect(
      handler.handle(new OrderPlaced(WORKSPACE, ORDER, 1, AMOUNT, LATER)),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      `failed to request charge orderId=${ORDER} attempt=1`,
      expect.stringContaining('broker down'),
    );
  });
});
