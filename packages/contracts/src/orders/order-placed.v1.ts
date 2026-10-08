import { z } from 'zod';

import { defineMessage } from '../envelope';
import { money } from '../money';

/**
 * Event, owned by orders (the publisher): an order was placed and waits for payment attempt
 * `paymentAttempt`. Placed again after a failed payment, it is published again with the next
 * attempt.
 */
export const OrderPlacedV1 = defineMessage(
  'orders.order-placed',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    /** What the order costs: the amount the attempt is charged. */
    amount: money,
  }),
);

export type OrderPlacedV1 = z.infer<typeof OrderPlacedV1.schema>;
