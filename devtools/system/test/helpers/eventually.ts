// The only way a system test waits: it cannot stop a service at a step or ask a queue whether
// it is empty, so it looks again until what it expects is there. Never a sleep: a wait that
// is long enough on this machine is too short on the next one.
export async function eventually<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 30_000, intervalMs = 200, what = 'condition' } = {},
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
