import { z } from 'zod';

import { defineMessage } from '../envelope';

/**
 * Command, owned by inventory (the receiver): hold stock for one attempt of an order, every
 * line or none. The answer is `StockReservedV1` or `StockReservationFailedV1` with the same
 * `orderId` and `attempt`.
 */
export const ReserveStockV1 = defineMessage(
  'inventory.reserve-stock',
  1,
  z.object({
    orderId: z.uuid(),
    /** Which placing of the order: placed again, an order asks for a new reservation. */
    attempt: z.int().positive(),
    lines: z.array(z.object({ productId: z.uuid(), quantity: z.int().positive() })).min(1),
  }),
);

export type ReserveStockV1 = z.infer<typeof ReserveStockV1.schema>;
