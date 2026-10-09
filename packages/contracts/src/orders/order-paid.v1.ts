import { z } from 'zod';

import { defineMessage } from '../envelope';
import { money } from '../money';
import { recipient } from '../recipient';

/** Event, owned by orders (the publisher): the payment attempt was charged, the order is paid. */
export const OrderPaidV1 = defineMessage(
  'orders.order-paid',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    /** The provider's id of the charge. */
    chargeId: z.string().min(1),
    /** What was charged. */
    amount: money,
    /** The user who created the order. */
    recipient,
  }),
);

export type OrderPaidV1 = z.infer<typeof OrderPaidV1.schema>;
