import { z } from 'zod';

import { defineMessage } from '../envelope';

/** Event, owned by orders (the publisher): the order was cancelled and will not be fulfilled. */
export const OrderCancelledV1 = defineMessage(
  'orders.order-cancelled',
  1,
  z.object({ orderId: z.uuid() }),
);

export type OrderCancelledV1 = z.infer<typeof OrderCancelledV1.schema>;
