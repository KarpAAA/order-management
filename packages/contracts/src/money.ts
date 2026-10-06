import { z } from 'zod';

/**
 * Money on the wire, the same shape as in the HTTP API: minor units as a safe integer and an
 * ISO 4217 code. JSON has no bigint; a service converts to its own money type at the edge.
 */
export const money = z.object({
  amountMinor: z.int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export type Money = z.infer<typeof money>;
