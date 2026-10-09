import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';

import type { JobsOptions, Queue } from 'bullmq';

/** The queue of this folder (transport/queues.md §1). It carries scheduler ticks only. */
export const INBOX_QUEUE = 'inbox';

export interface InboxJobs {
  /** A scheduler tick: no payload, the job class decides what to do (transport/cron.md §2). */
  'cron:cleanup-inbox': Record<string, never>;
}

export type InboxCronJobName = Extract<keyof InboxJobs, `cron:${string}`>;

const CRON_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
};

/** Producer. Retention defaults are set at queue registration. */
@Injectable()
export class InboxQueue {
  constructor(@InjectQueue(INBOX_QUEUE) private readonly queue: Queue) {}

  /** One scheduler per id in Redis, however many workers start; the first tick runs at once. */
  async upsertScheduler(
    schedulerId: string,
    name: InboxCronJobName,
    pattern: string,
  ): Promise<void> {
    await this.queue.upsertJobScheduler(
      schedulerId,
      { pattern, immediately: true },
      { name, data: {}, opts: CRON_JOB_OPTIONS },
    );
  }
}
