// Waiting for asynchronous outcomes without sleep(): poll a probe until a condition holds,
// fail with the last observed value when it never does.
import type { ApiApp } from './api-app';
import type { Job, Queue } from 'bullmq';

export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 10_000, intervalMs = 25, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${String(timeoutMs)} ms waiting for ${what}; last: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await probe();
  }
  return last;
}

/** Polls GET /orders/{id} like a client does (async-push: poll) until a final status. */
export function waitForStatus(
  api: ApiApp,
  path: string,
  as: { Authorization: string },
  statuses: readonly string[],
): Promise<Record<string, unknown>> {
  return waitFor(
    async () => (await api.http().get(path).set(as).expect(200)).body as Record<string, unknown>,
    (order) => statuses.includes(order.status as string),
    { what: `status ${statuses.join(' | ')} of ${path}` },
  );
}

export interface FinishedJob {
  state: 'completed' | 'failed';
  attemptsMade: number;
  job: Job;
}

/** Until the job is completed or failed (with retries exhausted). */
export async function waitForJob(queue: Queue, jobId: string): Promise<FinishedJob> {
  const snapshot = async () => {
    const job = await queue.getJob(jobId);
    return { job, state: job ? await job.getState() : 'missing' };
  };
  const { job, state } = await waitFor(
    snapshot,
    ({ state: s }) => s === 'completed' || s === 'failed',
    { what: `job ${jobId} to finish` },
  );
  if (!job) throw new Error(`job ${jobId} vanished`);
  return { state: state as FinishedJob['state'], attemptsMade: job.attemptsMade, job };
}
