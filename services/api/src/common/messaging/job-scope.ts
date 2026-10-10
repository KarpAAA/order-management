import { Inject, Injectable } from '@nestjs/common';

import { newId } from '@shared/domain/id';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { CorrelationContext } from './correlation-context';
import { correlationIdFrom } from './correlation-header';

import type { Job } from 'bullmq';

/**
 * What a job is run in: the correlation id of whatever enqueued it, and its line in the log
 * (ops/logging.md §3). A producer that enqueues from a request or a message puts
 * `correlationId` in the data of the job; a scheduler tick has none and starts a chain of
 * its own. Every `process()` of a `@Processor` goes through here.
 */
@Injectable()
export class JobScope {
  private readonly log: Logger;

  constructor(
    private readonly correlation: CorrelationContext,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: JobScope.name });
  }

  run<T>(job: Job, work: () => Promise<T>): Promise<T> {
    const data = job.data as { correlationId?: unknown } | undefined;
    return this.correlation.run(correlationIdFrom(data?.correlationId) ?? newId(), async () => {
      const startedAt = performance.now();
      const line = (outcome: 'ok' | 'failed') => ({
        queue: job.queueName,
        job: job.name,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        durationMs: Math.round(performance.now() - startedAt),
        outcome,
      });
      try {
        const result = await work();
        this.log.info(line('ok'), 'job run');
        return result;
      } catch (err: unknown) {
        // retried by the queue; the last failure is the `dead job` error of the consumer
        this.log.warn({ ...line('failed'), err }, 'job run');
        throw err;
      }
    });
  }
}
