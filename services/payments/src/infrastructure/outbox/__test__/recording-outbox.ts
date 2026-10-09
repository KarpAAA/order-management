import type { Outbox, OutboxEntry } from '../outbox';

/** Spy: what was appended, in order. The table itself is covered by the e2e suite. */
export function recordingOutbox(): { outbox: Outbox; appended: OutboxEntry[] } {
  const appended: OutboxEntry[] = [];
  const outbox = {
    append: (entry: OutboxEntry) => {
      appended.push(entry);
      return Promise.resolve();
    },
  } as unknown as Outbox;
  return { outbox, appended };
}
