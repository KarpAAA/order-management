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
 * Tells the rest of the system how a payment attempt ended. 3.2: published to the broker
 * after the row is saved, not atomically with it. ROADMAP 3.4: an outbox row written with the
 * payment, same port, new adapter.
 */
export interface PaymentEventsPublisher {
  publish(outcome: PaymentOutcome): Promise<void>;
}
