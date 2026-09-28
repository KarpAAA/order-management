import type { PrismaClient } from '@infra/database/generated/prisma/client';

/** A one-shot barrier: forces a chosen interleaving of concurrent transactions. */
export function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/**
 * Resolves once some other backend of this database is blocked on a lock — e.g. an UPDATE
 * waiting for a row another transaction holds. Deterministic, unlike a sleep.
 */
export async function untilSomeoneWaitsOnLock(db: PrismaClient, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ waiting }] = await db.$queryRaw<[{ waiting: number }]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no backend waited on a lock within ${String(timeoutMs)} ms`);
}
