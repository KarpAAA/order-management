import { z } from 'zod';

import { defineMessage } from '../envelope';

/**
 * Event, owned by inventory (the publisher): nothing is held for this attempt. Final for the
 * attempt: stock that arrives later does not revive it.
 */
export const StockReservationFailedV1 = defineMessage(
  'inventory.stock-reservation-failed',
  1,
  z.object({
    orderId: z.uuid(),
    attempt: z.int().positive(),
    reason: z.enum(['insufficient_stock']),
    /** The products that fell short, with what was free when the command was handled. */
    shortages: z
      .array(
        z.object({
          productId: z.uuid(),
          requested: z.int().positive(),
          available: z.int().nonnegative(),
        }),
      )
      .min(1),
  }),
);

export type StockReservationFailedV1 = z.infer<typeof StockReservationFailedV1.schema>;
