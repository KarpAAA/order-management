import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';

import { RecordingLogger } from '@shared/logger/__test__/recording-logger';

import { activeTraceId, recordingTracer } from '../tracing/__test__/recording-tracer';

import { CorrelationContext } from './correlation-context';
import { correlationIdFrom } from './correlation-header';
import { JobScope } from './job-scope';

import type { Job } from 'bullmq';

const ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03';
const OTHER = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const cls = ClsServiceManager.getClsService();
const correlation = () => new CorrelationContext(cls);

describe('correlationIdFrom: what a caller may name its chain with (LOG-010)', () => {
  it('takes a UUID, in lower case', () => {
    expect(correlationIdFrom(ID)).toBe(ID);
    expect(correlationIdFrom(ID.toUpperCase())).toBe(ID);
  });

  it.each([
    ['nothing', undefined],
    ['an empty header', ''],
    ['a word', 'my-request'],
    ['a line break (log injection)', `${ID}\n{"level":"error"}`],
    ['a repeated header', [ID, OTHER]],
    ['a number', 42],
  ])('does not take %s', (_case, value) => {
    expect(correlationIdFrom(value)).toBeUndefined();
  });
});

describe('CorrelationContext (LOG-011)', () => {
  it('has no id outside a chain', () => {
    expect(correlation().current()).toBeUndefined();
  });

  it('runs work as a part of a chain, and leaves the chain with it', async () => {
    const context = correlation();

    const inside = await context.run(ID, async () => {
      await Promise.resolve();
      return { current: context.current(), id: context.id() };
    });

    expect(inside).toEqual({ current: ID, id: ID });
    expect(context.current()).toBeUndefined();
  });

  it('keeps two chains apart while they run at once', async () => {
    const context = correlation();
    const seen = (id: string) =>
      context.run(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return context.current();
      });

    expect(await Promise.all([seen(ID), seen(OTHER)])).toEqual([ID, OTHER]);
  });

  it('inherits what the scope around it holds: a nested chain does not leave a transaction', () => {
    const context = correlation();
    const HELD = Symbol('held');

    const held = cls.run(() => {
      cls.set(HELD, 'transaction');
      return context.run(ID, () => cls.get<string>(HELD));
    });

    expect(held).toBe('transaction');
  });

  it('continues another chain inside a scope: what follows belongs to it', () => {
    const context = correlation();

    const after = context.run(ID, () => {
      context.continue(OTHER);
      return context.current();
    });

    expect(after).toBe(OTHER);
  });
});

describe('JobScope (LOG-013)', () => {
  const job = (data: unknown): Job =>
    ({ id: 'j-1', name: 'cron:cleanup-outbox', queueName: 'outbox', attemptsMade: 0, data }) as Job;

  function scope() {
    const logger = new RecordingLogger();
    const context = correlation();
    return { jobs: new JobScope(context, logger), context, logger };
  }

  it('runs a job under the correlation id its producer put in the data', async () => {
    const { jobs, context } = scope();

    expect(
      await jobs.run(job({ correlationId: ID }), () => Promise.resolve(context.current())),
    ).toBe(ID);
  });

  it('starts a chain of its own for a scheduler tick, which has none', async () => {
    const { jobs, context } = scope();

    const first = await jobs.run(job({}), () => Promise.resolve(context.current()));
    const second = await jobs.run(job({}), () => Promise.resolve(context.current()));

    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it('writes the line of the run: which job, which attempt, how long, how it ended', async () => {
    const { jobs, logger } = scope();

    await jobs.run(job({}), () => Promise.resolve());

    expect(logger.lines).toEqual([
      {
        level: 'info',
        message: 'job run',
        fields: {
          context: 'JobScope',
          queue: 'outbox',
          job: 'cron:cleanup-outbox',
          jobId: 'j-1',
          attempt: 1,
          durationMs: expect.any(Number),
          outcome: 'ok',
        },
      },
    ]);
  });

  it('logs a failed run with its error and lets it out: the queue retries', async () => {
    const { jobs, logger } = scope();
    const error = new Error('database is down');

    await expect(jobs.run(job({}), () => Promise.reject(error))).rejects.toBe(error);

    expect(logger.at('warn')).toMatchObject([
      { message: 'job run', fields: { outcome: 'failed', err: error } },
    ]);
  });

  it('TRC-030 runs a job as a span of the trace its producer put in the data', async () => {
    const tracing = recordingTracer();
    tracing.reset();
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const { jobs } = scope();

    const seen = await jobs.run(job({ traceparent: `00-${traceId}-b7ad6b7169203331-01` }), () =>
      Promise.resolve(activeTraceId()),
    );
    await jobs.run(job({}), () => Promise.resolve());

    const [fromProducer, tick] = tracing.spans();
    expect(seen).toBe(traceId);
    expect(fromProducer?.spanContext().traceId).toBe(traceId);
    // a scheduler tick has no trace: its span begins one
    expect(tick?.parentSpanContext).toBeUndefined();
    expect(tick?.spanContext().traceId).not.toBe(traceId);
  });
});
