// Waiting for asynchronous outcomes without sleep(): poll a probe until a condition holds,
// fail with the last observed value when it never does.
import type { ApiApp } from './api-app';

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
