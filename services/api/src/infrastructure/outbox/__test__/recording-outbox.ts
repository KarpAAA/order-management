import type { CorrelationContext } from '@common/messaging/correlation-context';

import type { Outbox, OutboxEntry } from '../outbox';

/** Spy: what was appended, in order. The table itself is covered by the int suite. */
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

/** Stub: every message belongs to the chain `correlationId`. */
export const correlationOf = (correlationId: string): CorrelationContext =>
  ({ id: () => correlationId }) as unknown as CorrelationContext;
