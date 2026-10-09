// Waiting for asynchronous outcomes without sleep(): poll a probe until a condition holds,
// fail with the last observed value when it never does.
export async function waitFor<T>(
  probe: () => Promise<T> | T,
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
