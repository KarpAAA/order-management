import { z } from 'zod';

import { defineMessage } from '../envelope';

/**
 * Event, owned by payments (the publisher): this payment attempt was cancelled before it was
 * charged. Final for the attempt: a charge command that arrives later charges nothing.
 */
export const PaymentCancelledV1 = defineMessage(
  'payments.payment-cancelled',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
  }),
);

export type PaymentCancelledV1 = z.infer<typeof PaymentCancelledV1.schema>;
