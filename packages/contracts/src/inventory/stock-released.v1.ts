import { z } from 'zod';

import { defineMessage } from '../envelope';

/** Event, owned by inventory (the publisher): this attempt of the order holds no stock. */
export const StockReleasedV1 = defineMessage(
  'inventory.stock-released',
  1,
  z.object({
    orderId: z.uuid(),
    attempt: z.int().positive(),
  }),
);

export type StockReleasedV1 = z.infer<typeof StockReleasedV1.schema>;
