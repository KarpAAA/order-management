import { z } from 'zod';

import { defineMessage } from '../envelope';

/**
 * Command, owned by payments (the receiver): do not charge this payment attempt of an order.
 * The answer says what the attempt ended as, with the same `orderId` and `paymentAttempt`:
 * `PaymentCancelledV1` when nothing was charged and nothing will be, `PaymentSucceededV1` or
 * `PaymentFailedV1` when the attempt had ended before the command was handled.
 */
export const CancelPaymentV1 = defineMessage(
  'payments.cancel-payment',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
  }),
);

export type CancelPaymentV1 = z.infer<typeof CancelPaymentV1.schema>;
