import { z } from 'zod';

import { defineMessage } from '../envelope';
import { recipient } from '../recipient';

/**
 * Event, owned by orders (the publisher): attempt `paymentAttempt` ended before a charge was
 * asked for, and the order is a DRAFT again. Nothing was charged; the order can be changed
 * and placed again.
 */
export const OrderReturnedToDraftV1 = defineMessage(
  'orders.order-returned-to-draft',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    /** `out_of_stock`, or `inventory_unavailable` when the reservation was never answered. */
    reason: z.string().min(1),
    /** The user who created the order. */
    recipient,
  }),
);

export type OrderReturnedToDraftV1 = z.infer<typeof OrderReturnedToDraftV1.schema>;
