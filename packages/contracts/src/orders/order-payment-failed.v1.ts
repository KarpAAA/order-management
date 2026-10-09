import { z } from 'zod';

import { defineMessage } from '../envelope';
import { money } from '../money';
import { recipient } from '../recipient';

/**
 * Event, owned by orders (the publisher): payment attempt `paymentAttempt` ended without a
 * charge and the order is PAYMENT_FAILED. The order can be placed again, as the next attempt.
 */
export const OrderPaymentFailedV1 = defineMessage(
  'orders.order-payment-failed',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    /** A decline code of the provider, `psp_unavailable`, `expired` or `payment_timeout`. */
    reason: z.string().min(1),
    /** What the attempt would have charged. */
    amount: money,
    /** The user who created the order. */
    recipient,
  }),
);

export type OrderPaymentFailedV1 = z.infer<typeof OrderPaymentFailedV1.schema>;
