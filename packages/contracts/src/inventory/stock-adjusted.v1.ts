import { z } from 'zod';

import { defineMessage } from '../envelope';

/**
 * Event, owned by inventory (the publisher): the stock on hand of a product changed. Carries
 * the levels after the change, not the difference.
 */
export const StockAdjustedV1 = defineMessage(
  'inventory.stock-adjusted',
  1,
  z.object({
    productId: z.uuid(),
    onHand: z.int().nonnegative(),
    /** Held by reservations; `onHand - reserved` is free. */
    reserved: z.int().nonnegative(),
  }),
);

export type StockAdjustedV1 = z.infer<typeof StockAdjustedV1.schema>;
