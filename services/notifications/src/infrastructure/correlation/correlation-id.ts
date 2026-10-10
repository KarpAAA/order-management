import { z } from 'zod';

/** The header a chain is named with towards a service that is called over HTTP. */
export const CORRELATION_HEADER = 'x-correlation-id';

// the check of the envelope (`@oms/contracts`): an id that passes here passes there
const uuid = z.uuid();

/** A correlation id that may be continued: a UUID, as the contract of a message requires. */
export function correlationIdFrom(value: unknown): string | undefined {
  const parsed = uuid.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : undefined;
}
