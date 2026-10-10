import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  failSpan,
  inSpan,
  runInTraceContext,
  traceCarrierFrom,
} from '@common/tracing/trace-context';
import { newId } from '@shared/domain/id';
import { LOGGER, type Logger } from '@shared/logger/logger';
import {
  METRICS,
  secondsSince,
  type Counter,
  type Gauge,
  type Histogram,
  type Metrics,
} from '@shared/observability/metrics';
import { silentMetrics } from '@shared/observability/silent-metrics';

import { CorrelationContext } from './correlation-context';
import { correlationIdFrom } from './correlation-header';

import type { Job } from 'bullmq';

/**
 * What a job is run in: the correlation id of whatever enqueued it, and its line in the log
 * (ops/logging.md §3). A producer that enqueues from a request or a message puts
 * `correlationId` in the data of the job; a scheduler tick has none and starts a chain of
 * its own. Every `process()` of a `@Processor` goes through here.
 *
 * The trace travels the same way (docs/adr/0025): `traceparent` in the data of the job, and
 * the run is a span of that trace. A tick has none, and its span begins a trace.
 *
 * And it counts the run (ops/observability.md §1): how long it took and how it ended, and
 * when a job last went through, which is how a schedule that stopped is noticed.
 */
@Injectable()
export class JobScope {
  private readonly log: Logger;
  private readonly duration: Histogram<'queue' | 'job' | 'outcome'>;
  private readonly lastSuccess: Gauge<'queue' | 'job'>;
  private readonly dead: Counter<'queue' | 'job'>;

  constructor(
    private readonly correlation: CorrelationContext,
    @Inject(LOGGER) logger: Logger,
    // left out by a test that builds the scope by hand
    @Optional() @Inject(METRICS) metrics: Metrics = silentMetrics,
  ) {
    this.log = logger.child({ context: JobScope.name });
    this.duration = metrics.histogram({
      name: 'queue_job_duration_seconds',
      help: 'Time one run of a job took, by how it ended.',
      labels: ['queue', 'job', 'outcome'],
    });
    this.lastSuccess = metrics.gauge({
      name: 'cron_last_success_timestamp_seconds',
      help: 'When a job last ran through, as a Unix time.',
      labels: ['queue', 'job'],
    });
    this.dead = metrics.counter({
      name: 'queue_job_dead_total',
      help: 'Jobs given up: attempts spent, or failed for good.',
      labels: ['queue', 'job'],
    });
  }

  /** Counts a job its consumer has given up (`dlq: alert`); the consumer writes the error. */
  died(job: Job): void {
    this.dead.inc({ queue: job.queueName, job: job.name });
  }

  run<T>(job: Job, work: () => Promise<T>): Promise<T> {
    const data = job.data as { correlationId?: unknown } | undefined;
    const correlationId = correlationIdFrom(data?.correlationId) ?? newId();
    return runInTraceContext(traceCarrierFrom(data), () =>
      inSpan(`job ${job.queueName} ${job.name}`, (span) =>
        this.correlation.run(correlationId, () =>
          this.logged(job, work).catch((err: unknown) => {
            failSpan(span, err);
            throw err;
          }),
        ),
      ),
    );
  }

  private async logged<T>(job: Job, work: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    const line = (outcome: 'ok' | 'failed') => ({
      queue: job.queueName,
      job: job.name,
      jobId: job.id,
      attempt: job.attemptsMade + 1,
      durationMs: Math.round(performance.now() - startedAt),
      outcome,
    });
    const labels = { queue: job.queueName, job: job.name };
    try {
      const result = await work();
      this.duration.observe({ ...labels, outcome: 'ok' }, secondsSince(startedAt));
      this.lastSuccess.set(labels, Date.now() / 1000);
      this.log.info(line('ok'), 'job run');
      return result;
    } catch (err: unknown) {
      this.duration.observe({ ...labels, outcome: 'failed' }, secondsSince(startedAt));
      // retried by the queue; the last failure is the `dead job` error of the consumer
      this.log.warn({ ...line('failed'), err }, 'job run');
      throw err;
    }
  }
}
