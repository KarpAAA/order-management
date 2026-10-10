import { z } from 'zod';

/** The header a caller names its chain with, and the one every answer names it back with. */
export const CORRELATION_HEADER = 'x-correlation-id';

// the check of the envelope (`@oms/contracts`): an id that passes here passes there
const uuid = z.uuid();

/**
 * The correlation id a caller sent, if it may be used. Only a UUID is taken: the id travels
 * in every message this request causes, where the contract requires one, and into a column
 * of payments. Anything else is not continued: the entry starts a chain of its own.
 */
export function correlationIdFrom(value: unknown): string | undefined {
  const parsed = uuid.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : undefined;
}
