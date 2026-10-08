import { z } from 'zod';

import { defineMessage } from '../envelope';

/**
 * Command, owned by inventory (the receiver): the stock on hand of a product changed by
 * `delta`. A difference, never a level: it is added to what the stock is when the command
 * is handled. The answer is `StockAdjustedV1`.
 */
export const AdjustStockV1 = defineMessage(
  'inventory.adjust-stock',
  1,
  z.object({
    productId: z.uuid(),
    /** Units that arrived (positive) or left (negative). */
    delta: z.int().refine((delta) => delta !== 0, 'delta must not be 0'),
  }),
);

export type AdjustStockV1 = z.infer<typeof AdjustStockV1.schema>;
