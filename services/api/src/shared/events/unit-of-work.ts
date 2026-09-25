import { AsyncLocalStorage } from 'node:async_hooks';

type Callback = () => void | Promise<void>;

/**
 * A per-use-case buffer of "after commit" callbacks.
 *
 * `@nestjs-cls/transactional` has no commit hook, so the outermost `@UseCase()` opens a unit
 * of work around `execute`. `@Transactional()` sits inside it, so by the time the wrapped
 * call resolves the transaction has committed and the buffer is flushed; if it throws
 * (rollback) the buffer is dropped. Nested use cases join the outer unit of work.
 */
const storage = new AsyncLocalStorage<Callback[]>();

export async function runInUnitOfWork<T>(work: () => Promise<T>): Promise<T> {
  if (storage.getStore()) return work();
  const callbacks: Callback[] = [];
  const result = await storage.run(callbacks, work);
  for (const callback of callbacks) await callback();
  return result;
}

/** Runs `callback` after the current unit of work succeeds, or immediately outside one. */
export async function afterCommit(callback: Callback): Promise<void> {
  const callbacks = storage.getStore();
  if (callbacks) callbacks.push(callback);
  else await callback();
}
