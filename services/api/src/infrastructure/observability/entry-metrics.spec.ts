import { EventEmitter } from 'node:events';

import { Test } from '@nestjs/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithActor } from '@common/decorators/current-actor.decorator';
import { UseCase } from '@common/decorators/use-case.decorator';
import { httpEntry } from '@common/http/http-entry';
import { CorrelationContext } from '@common/messaging/correlation-context';
import { JobScope } from '@common/messaging/job-scope';
import { measurePool } from '@infra/database/pool.metrics';
import { brokerMeters } from '@infra/messaging/broker.meters';
import { retryOrPark } from '@infra/messaging/retry-or-park';
import { InvalidStateError } from '@shared/errors/domain-error';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import { LOGGER } from '@shared/logger/logger';
import { silentLogger } from '@shared/logger/silent-logger';
import { RecordingMetrics } from '@shared/observability/__test__/recording-metrics';
import { METRICS } from '@shared/observability/metrics';

import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Job } from 'bullmq';
import type { Response } from 'express';

const cls = ClsServiceManager.getClsService();

/**
 * What the entries of the process count (docs/adr/0027). Each observes where it already
 * writes its line, with the same closed set of values: these tests hold the names of the
 * metrics and of their labels, which the dashboards and the alert read.
 */
describe('the metric of an HTTP request (MET-010)', () => {
  function answered(route: string | undefined, status: number) {
    const metrics = new RecordingMetrics();
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: () => undefined });
    const req = { method: 'POST', headers: {}, ...(route ? { route: { path: route } } : {}) };
    cls.run(() => {
      httpEntry(silentLogger, metrics)(
        cls,
        req as unknown as RequestWithActor,
        res as unknown as Response,
      );
    });
    res.statusCode = status;
    res.emit('finish');
    return metrics.of('http_request_duration_seconds');
  }

  it('observes the request once, when it is answered: method, the route as its pattern, status', () => {
    const [sample, ...rest] = answered('/v1/workspaces/:workspaceId/orders/:orderId/place', 202);

    expect(rest).toEqual([]);
    expect(sample?.labels).toEqual({
      method: 'POST',
      route: '/v1/workspaces/:workspaceId/orders/:orderId/place',
      status: 202,
    });
    expect(sample?.value).toBeGreaterThanOrEqual(0);
    // seconds, not milliseconds
    expect(sample?.value).toBeLessThan(1);
  });

  it('gives every request no route matched one value of the label, whatever its URL', () => {
    expect(answered(undefined, 404)[0]?.labels).toMatchObject({ route: 'unmatched', status: 404 });
  });
});

describe('the metric of a use case (MET-011)', () => {
  class NotPayable extends InvalidStateError {
    readonly code = 'ORDER_NOT_PAYABLE';
  }

  @UseCase()
  class PayOrderService {
    // eslint-disable-next-line @typescript-eslint/require-await -- the shape of a use case
    async execute(fail?: Error): Promise<void> {
      if (fail) throw fail;
    }
  }

  async function provided() {
    const metrics = new RecordingMetrics();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PayOrderService,
        { provide: LOGGER, useValue: silentLogger },
        { provide: METRICS, useValue: metrics },
      ],
    }).compile();
    return { useCase: moduleRef.get(PayOrderService), metrics };
  }

  it.each([
    ['ok', undefined],
    ['ORDER_NOT_PAYABLE', new NotPayable('not payable')],
    ['error', new Error('the database is away')],
  ])('observes its duration with the outcome %s', async (outcome, fail) => {
    const { useCase, metrics } = await provided();

    await useCase.execute(fail).catch(() => undefined);

    expect(metrics.of('use_case_duration_seconds').map((sample) => sample.labels)).toEqual([
      { use_case: 'PayOrderService', outcome },
    ]);
  });

  it('counts nothing for a use case built by hand, and runs it', async () => {
    await expect(new PayOrderService().execute()).resolves.toBeUndefined();
  });
});

describe('the metrics of a job (MET-012)', () => {
  const job = { id: 'j-1', name: 'cron:cleanup-outbox', queueName: 'outbox', attemptsMade: 0 };
  const labels = { queue: 'outbox', job: 'cron:cleanup-outbox' };

  function scope() {
    const metrics = new RecordingMetrics();
    return { jobs: new JobScope(new CorrelationContext(cls), silentLogger, metrics), metrics };
  }

  it('observes a run that went through, and remembers when', async () => {
    const { jobs, metrics } = scope();
    const before = Date.now() / 1000;

    await jobs.run(job as Job, () => Promise.resolve());

    expect(metrics.of('queue_job_duration_seconds')[0]?.labels).toEqual({
      ...labels,
      outcome: 'ok',
    });
    const [last] = metrics.of('cron_last_success_timestamp_seconds');
    expect(last?.labels).toEqual(labels);
    expect(last?.value).toBeGreaterThanOrEqual(before);
  });

  it('observes a run that failed, and leaves the last success as it was', async () => {
    const { jobs, metrics } = scope();

    await jobs.run(job as Job, () => Promise.reject(new Error('boom'))).catch(() => undefined);

    expect(metrics.of('queue_job_duration_seconds')[0]?.labels).toEqual({
      ...labels,
      outcome: 'failed',
    });
    expect(metrics.of('cron_last_success_timestamp_seconds')).toEqual([]);
  });

  it('counts a job its consumer gave up', () => {
    const { jobs, metrics } = scope();

    jobs.died(job as Job);

    expect(metrics.total('queue_job_dead_total', labels)).toBe(1);
  });
});

describe('the metrics of a broker message (MET-013)', () => {
  const QUEUE = 'api.payment-events';
  const POLICY = { maxAttempts: 2, delayMs: 200 };

  const message = (rejected: number) =>
    ({
      content: Buffer.from('{}'),
      fields: {},
      properties: {
        headers: { 'x-death': [{ queue: QUEUE, reason: 'rejected', count: rejected }] },
      },
    }) as unknown as ConsumeMessage;

  async function settled(rejected: number, error: unknown) {
    const metrics = new RecordingMetrics();
    const channel = {
      ack: vi.fn(),
      nack: vi.fn(),
      sendToQueue: (_q: string, _c: Buffer, _o: unknown, done: (err: unknown) => void) => {
        done(null);
      },
    };
    const handler = retryOrPark(QUEUE, POLICY, {
      logger: silentLogger,
      correlation: { run: (_id, work) => work() },
      meters: brokerMeters(metrics),
    });
    await handler(channel as unknown as ConfirmChannel, message(rejected), error);
    return metrics;
  }

  it('observes a delivery by its queue and how it ended', () => {
    const metrics = new RecordingMetrics();
    const meters = brokerMeters(metrics);

    meters.delivered(QUEUE, 'ok', performance.now());
    meters.delivered(QUEUE, 'failed', performance.now());

    expect(metrics.of('broker_message_duration_seconds').map((sample) => sample.labels)).toEqual([
      { queue: QUEUE, outcome: 'ok' },
      { queue: QUEUE, outcome: 'failed' },
    ]);
  });

  it('counts a failed delivery that comes again as retried', async () => {
    const metrics = await settled(0, new Error('the database is away'));

    expect(metrics.total('broker_messages_retried_total', { queue: QUEUE })).toBe(1);
    expect(metrics.total('broker_messages_parked_total')).toBe(0);
  });

  it.each([
    ['its last delivery failed', 1, new Error('the database is away')],
    ['it can never be handled', 0, new UnprocessableMessageError('not a contract')],
  ])('counts a message as parked when %s', async (_case, rejected, error) => {
    const metrics = await settled(rejected, error);

    expect(metrics.total('broker_messages_parked_total', { queue: QUEUE })).toBe(1);
    expect(metrics.total('broker_messages_retried_total')).toBe(0);
  });
});

describe('the metric of a connection pool (MET-016)', () => {
  it('reads the pool when the metrics are read: held, free, and queries that wait', async () => {
    const metrics = new RecordingMetrics();
    const pool = { totalCount: 10, idleCount: 0, waitingCount: 0 };

    measurePool(metrics, 'primary')(pool);
    measurePool(metrics, 'replica')({ totalCount: 2, idleCount: 2, waitingCount: 0 });
    // read at the scrape, not when the pool was handed over
    pool.waitingCount = 3;

    expect(await metrics.collected('db_pool_connections')).toEqual([
      { labels: { pool: 'primary', state: 'total' }, value: 10 },
      { labels: { pool: 'primary', state: 'idle' }, value: 0 },
      { labels: { pool: 'primary', state: 'waiting' }, value: 3 },
      { labels: { pool: 'replica', state: 'total' }, value: 2 },
      { labels: { pool: 'replica', state: 'idle' }, value: 2 },
      { labels: { pool: 'replica', state: 'waiting' }, value: 0 },
    ]);
  });

  it('has no sample of a pool that does not exist yet: the client has not connected', async () => {
    const metrics = new RecordingMetrics();

    measurePool(metrics, 'primary');

    expect(await metrics.collected('db_pool_connections')).toEqual([]);
  });
});
