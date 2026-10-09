import { z } from 'zod';

import { defineMessage } from '../envelope';
import { recipient } from '../recipient';

/** Event, owned by orders (the publisher): a paid order was handed over. */
export const OrderFulfilledV1 = defineMessage(
  'orders.order-fulfilled',
  1,
  z.object({
    orderId: z.uuid(),
    /** The user who created the order. */
    recipient,
  }),
);

export type OrderFulfilledV1 = z.infer<typeof OrderFulfilledV1.schema>;
