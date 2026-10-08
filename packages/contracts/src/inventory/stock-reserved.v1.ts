import { z } from 'zod';

import { defineMessage } from '../envelope';

/** Event, owned by inventory (the publisher): every line of this attempt is held. */
export const StockReservedV1 = defineMessage(
  'inventory.stock-reserved',
  1,
  z.object({
    orderId: z.uuid(),
    attempt: z.int().positive(),
  }),
);

export type StockReservedV1 = z.infer<typeof StockReservedV1.schema>;
