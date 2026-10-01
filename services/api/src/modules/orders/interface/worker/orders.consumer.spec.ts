import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '@common/tenancy/tenant-context';
import type { OrdersQueueConfig } from '@config/configuration';
import { InvalidStateError } from '@shared/errors/domain-error';
import { InfrastructureError } from '@shared/errors/infrastructure-error';

import { OrdersConsumer } from './orders.consumer';

import type { MaintainOrderEventPartitionsJob } from './maintain-order-event-partitions.job';
import type { ProcessOrderPaymentService } from '../../application/process-order-payment.service';
import type { OrdersJobs } from '../../infrastructure/orders.queue';
import type { Job } from 'bullmq';

const WORKSPACE = '01990000-0000-7000-8000-a00000000000';
const ORDER = '01990000-0000-7000-8000-a20000000001';

class VendorDown extends InfrastructureError {
  readonly code = 'VENDOR_DOWN';
  constructor(readonly retryable: boolean) {
    super('vendor down');
  }
}

class NotPayable extends InvalidStateError {
  readonly code = 'NOT_PAYABLE';
}

type ChargeJob = Job<OrdersJobs['charge-order']>;

const fakeJob = (overrides: Partial<ChargeJob> = {}): ChargeJob =>
  ({
    id: 'charge-1',
    name: 'charge-order',
    data: { workspaceId: WORKSPACE, orderId: ORDER, paymentAttempt: 1 },
    opts: { attempts: 5 },
    attemptsMade: 0,
    ...overrides,
  }) as ChargeJob;

/**
 * The consumer with its use case replaced by `execute` and the cron job by `run`; the tenant
 * runs the work directly.
 */
function consumerWith(
  execute: ProcessOrderPaymentService['execute'],
  run: MaintainOrderEventPartitionsJob['run'] = vi.fn(),
) {
  const runInWorkspace = vi.fn((_workspaceId: string, work: () => Promise<unknown>) => work());
  const consumer = new OrdersConsumer(
    { runInWorkspace } as unknown as TenantContext,
    { execute } as ProcessOrderPaymentService,
    { run } as MaintainOrderEventPartitionsJob,
    { concurrency: 1 } as OrdersQueueConfig,
  );
  return { consumer, runInWorkspace };
}

describe('OrdersConsumer routing (transport/queues.md §3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('charges the order in the workspace of the job, as the consumer system actor', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { consumer, runInWorkspace } = consumerWith(execute);

    await consumer.process(fakeJob());

    expect(runInWorkspace).toHaveBeenCalledWith(WORKSPACE, expect.any(Function));
    expect(execute).toHaveBeenCalledWith(
      { orderId: ORDER, paymentAttempt: 1, isFinalAttempt: false },
      expect.objectContaining({ kind: 'system', source: 'consumer:orders' }),
    );
  });

  it('marks the last attempt as final, so a transient failure ends as PAYMENT_FAILED (PAY-007)', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await consumerWith(execute).consumer.process(fakeJob({ attemptsMade: 4 }));

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ isFinalAttempt: true }),
      expect.anything(),
    );
  });

  it('runs the partition maintenance job on its cron tick, outside any workspace', async () => {
    const execute = vi.fn();
    const run = vi.fn().mockResolvedValue(undefined);
    const { consumer, runInWorkspace } = consumerWith(execute, run);

    await consumer.process(
      fakeJob({ name: 'cron:maintain-order-event-partitions', data: {} as never }),
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(runInWorkspace).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets a failed maintenance run fail the job, so BullMQ retries it', async () => {
    const error = new Error('database is down');
    const { consumer } = consumerWith(vi.fn(), vi.fn().mockRejectedValue(error));

    await expect(
      consumer.process(fakeJob({ name: 'cron:maintain-order-event-partitions' })),
    ).rejects.toBe(error);
  });

  it('fails an unknown job name for good', async () => {
    const { consumer } = consumerWith(vi.fn());

    await expect(consumer.process(fakeJob({ name: 'expire-order' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('completes a job whose order is already settled (idempotent replay)', async () => {
    const { consumer } = consumerWith(vi.fn().mockRejectedValue(new NotPayable('settled')));

    await expect(consumer.process(fakeJob())).resolves.toBeUndefined();
  });

  it('does not retry a non-retryable infrastructure error', async () => {
    const { consumer } = consumerWith(vi.fn().mockRejectedValue(new VendorDown(false)));

    await expect(consumer.process(fakeJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows a retryable one, so BullMQ applies attempts and backoff', async () => {
    const error = new VendorDown(true);
    const { consumer } = consumerWith(vi.fn().mockRejectedValue(error));

    await expect(consumer.process(fakeJob())).rejects.toBe(error);
  });
});

describe('OrdersConsumer dead jobs (dlq: alert, transport/queues.md §4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['all attempts spent', fakeJob({ attemptsMade: 5 }), new Error('PSP down')],
    [
      'failed by UnrecoverableError after one attempt',
      fakeJob({ attemptsMade: 1 }),
      new UnrecoverableError('bad key'),
    ],
  ])('alerts on a job %s', (_case, job, err) => {
    const alert = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    consumerWith(vi.fn()).consumer.onFailed(job, err);

    expect(alert).toHaveBeenCalledWith(expect.stringContaining('dead job charge-order'));
  });

  it('stays quiet on an attempt that BullMQ will retry', () => {
    const alert = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    consumerWith(vi.fn()).consumer.onFailed(fakeJob({ attemptsMade: 2 }), new Error('PSP down'));

    expect(alert).not.toHaveBeenCalled();
  });
});
