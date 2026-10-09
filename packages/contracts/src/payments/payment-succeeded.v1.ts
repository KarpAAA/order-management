import { z } from 'zod';

import { defineMessage } from '../envelope';

/** Event, owned by payments (the publisher): the provider charged this payment attempt. */
export const PaymentSucceededV1 = defineMessage(
  'payments.payment-succeeded',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    /** The provider's id of the charge. */
    chargeId: z.string().min(1),
  }),
);

export type PaymentSucceededV1 = z.infer<typeof PaymentSucceededV1.schema>;
