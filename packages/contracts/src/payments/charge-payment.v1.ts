import { z } from 'zod';

import { defineMessage } from '../envelope';
import { money } from '../money';

/**
 * Command, owned by payments (the receiver): charge one payment attempt of an order.
 * The answer is `PaymentSucceededV1` or `PaymentFailedV1` with the same `orderId` and
 * `paymentAttempt`.
 */
export const ChargePaymentV1 = defineMessage(
  'payments.charge-payment',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    amount: money,
    /** Same key → the same result, and the provider never charges twice. */
    idempotencyKey: z.string().min(1),
  }),
);

export type ChargePaymentV1 = z.infer<typeof ChargePaymentV1.schema>;
