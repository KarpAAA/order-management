import { PaymentStatus } from '@infra/database/generated/prisma/client';
import type { Payment } from '@infra/database/generated/prisma/client';

import type { PaymentOutcome, PaymentResult } from './ports/payment-events-publisher.port';

export const PSP_UNAVAILABLE = 'psp_unavailable';
export const PSP_REJECTED = 'psp_rejected';
/** The command was handled after the moment its sender had stopped waiting for. */
export const EXPIRED = 'expired';

export const PAYMENT_SELECT = {
  id: true,
  workspaceId: true,
  orderId: true,
  attempt: true,
  amountMinor: true,
  currency: true,
  idempotencyKey: true,
  status: true,
  pspChargeId: true,
  failureCode: true,
  correlationId: true,
  voidedAt: true,
} as const;

export type PaymentRow = Pick<Payment, keyof typeof PAYMENT_SELECT>;

/** How a settled row ended, as the answer says it. */
export const resultOf = (row: PaymentRow): PaymentResult => {
  if (row.status === PaymentStatus.CANCELLED) return { status: 'cancelled' };
  return row.status === PaymentStatus.SUCCEEDED && row.pspChargeId !== null
    ? { status: 'succeeded', chargeId: row.pspChargeId }
    : { status: 'failed', failureCode: row.failureCode ?? PSP_REJECTED, chargeId: row.pspChargeId };
};

export const outcomeOf = (row: PaymentRow): PaymentOutcome => ({
  workspaceId: row.workspaceId,
  orderId: row.orderId,
  paymentAttempt: row.attempt,
  correlationId: row.correlationId,
  result: resultOf(row),
});
