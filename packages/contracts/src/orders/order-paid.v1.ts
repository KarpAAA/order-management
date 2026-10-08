import { z } from 'zod';

import { defineMessage } from '../envelope';

/** Event, owned by orders (the publisher): the payment attempt was charged, the order is paid. */
export const OrderPaidV1 = defineMessage(
  'orders.order-paid',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    /** The provider's id of the charge. */
    chargeId: z.string().min(1),
  }),
);

export type OrderPaidV1 = z.infer<typeof OrderPaidV1.schema>;
