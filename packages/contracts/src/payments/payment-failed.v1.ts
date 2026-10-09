import { z } from 'zod';

import { defineMessage } from '../envelope';

/**
 * Event, owned by payments (the publisher): this payment attempt ended without a charge.
 * Final for the attempt: payments has spent its own retries before publishing it.
 */
export const PaymentFailedV1 = defineMessage(
  'payments.payment-failed',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    /** The provider's decline code, or `psp_unavailable` when the provider never answered. */
    declineCode: z.string().min(1),
    /** `null` when the provider never answered: there is no charge to point at. */
    chargeId: z.string().min(1).nullable(),
  }),
);

export type PaymentFailedV1 = z.infer<typeof PaymentFailedV1.schema>;
