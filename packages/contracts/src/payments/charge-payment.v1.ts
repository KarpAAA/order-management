import { z } from 'zod';

import { defineMessage } from '../envelope';
import { money } from '../money';

/**
 * Command, owned by payments (the receiver): charge one payment attempt of an order.
 * The answer is `PaymentSucceededV1` or `PaymentFailedV1` with the same `orderId` and
 * `paymentAttempt`; after a `CancelPaymentV1` for the attempt it may be `PaymentCancelledV1`.
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
    /**
     * Until when the sender waits for the charge. A command handled later charges nothing and
     * is answered `PaymentFailedV1` with `expired`. Absent: the command never expires.
     */
    expiresAt: z.iso.datetime().optional(),
  }),
);

export type ChargePaymentV1 = z.infer<typeof ChargePaymentV1.schema>;
