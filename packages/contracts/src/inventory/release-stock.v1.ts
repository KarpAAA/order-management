import { z } from 'zod';

import { defineMessage } from '../envelope';

/**
 * Command, owned by inventory (the receiver): give back what this attempt of an order holds.
 * It may arrive before the reservation it releases; that reservation then holds nothing.
 * The answer is `StockReleasedV1`.
 */
export const ReleaseStockV1 = defineMessage(
  'inventory.release-stock',
  1,
  z.object({
    orderId: z.uuid(),
    attempt: z.int().positive(),
  }),
);

export type ReleaseStockV1 = z.infer<typeof ReleaseStockV1.schema>;
