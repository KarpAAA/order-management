export const PAYMENT_EVENTS_PUBLISHER = Symbol('PAYMENT_EVENTS_PUBLISHER');

/** How a payment attempt ended. A failure is final for the attempt. */
export type PaymentResult =
  | { status: 'succeeded'; chargeId: string }
  /** `chargeId` is null when the provider never answered: there is no charge to point at. */
  | { status: 'failed'; failureCode: string; chargeId: string | null };

export interface PaymentOutcome {
  workspaceId: string;
  orderId: string;
  paymentAttempt: number;
  /** Of the command that asked for the charge. */
  correlationId: string;
  result: PaymentResult;
}

/**
 * Tells the rest of the system how a payment attempt ended.
 *
 * Called inside the transaction that settles the payment, and that is the contract of this
 * port: the answer is recorded with the row it tells about (an outbox row), never sent to the
 * outside from here. An adapter that calls a broker does not belong behind it.
 */
export interface PaymentEventsPublisher {
  publish(outcome: PaymentOutcome): Promise<void>;
}
