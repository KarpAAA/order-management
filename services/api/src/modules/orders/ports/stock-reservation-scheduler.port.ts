export const STOCK_RESERVATION_SCHEDULER = Symbol('STOCK_RESERVATION_SCHEDULER');

/** One placing of an order, as inventory knows it. */
export interface ReservationAttempt {
  workspaceId: string;
  orderId: string;
  attempt: number;
}

export interface RequestedReservation extends ReservationAttempt {
  /** What to hold: inventory cannot read the order. */
  lines: readonly { productId: string; quantity: number }[];
}

/**
 * "Hold this stock" and "give it back", asked of inventory-service; the answers come back as
 * events (`interface/worker/inventory-events.consumer.ts`).
 *
 * Called inside the transaction of the use case, and that is the contract of this port: the
 * request is recorded with the change that needs it (an outbox row), never sent to the
 * outside from here.
 */
export interface StockReservationScheduler {
  reserve(reservation: RequestedReservation): Promise<void>;
  /** The compensation. Safe to ask for an attempt that holds nothing, or was never heard of. */
  release(attempt: ReservationAttempt): Promise<void>;
}
