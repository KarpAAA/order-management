import type { CorrelationContext } from '@common/messaging/correlation-context';

import type { DelayedOutboxEntry, Outbox, OutboxEntry } from '../outbox';

/** Spy: what was appended, in order. The table itself is covered by the int suite. */
export function recordingOutbox(): {
  outbox: Outbox;
  appended: OutboxEntry[];
  delayed: DelayedOutboxEntry[];
} {
  const appended: OutboxEntry[] = [];
  const delayed: DelayedOutboxEntry[] = [];
  const outbox = {
    append: (entry: OutboxEntry) => {
      appended.push(entry);
      return Promise.resolve();
    },
    appendDelayed: (entry: DelayedOutboxEntry) => {
      delayed.push(entry);
      return Promise.resolve();
    },
  } as unknown as Outbox;
  return { outbox, appended, delayed };
}

/** Stub: every message belongs to the chain `correlationId`. */
export const correlationOf = (correlationId: string): CorrelationContext =>
  ({ id: () => correlationId }) as unknown as CorrelationContext;
