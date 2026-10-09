/** Mirrors the Prisma enum `OrderStatus` one-to-one. */
export enum OrderStatus {
  Draft = 'DRAFT',
  PendingPayment = 'PENDING_PAYMENT',
  Paid = 'PAID',
  PaymentFailed = 'PAYMENT_FAILED',
  Fulfilled = 'FULFILLED',
  Cancelled = 'CANCELLED',
}

/**
 * Mirrors the Prisma enum `OrderEventType`: one entry per status change, and one per step of
 * the saga that changes no status (`SagaNote`).
 */
export enum OrderEventType {
  OrderCreated = 'ORDER_CREATED',
  OrderPlaced = 'ORDER_PLACED',
  PaymentSucceeded = 'PAYMENT_SUCCEEDED',
  PaymentFailed = 'PAYMENT_FAILED',
  OrderFulfilled = 'ORDER_FULFILLED',
  OrderCancelled = 'ORDER_CANCELLED',
  StockReserved = 'STOCK_RESERVED',
  StockReservationFailed = 'STOCK_RESERVATION_FAILED',
  StockReleased = 'STOCK_RELEASED',
  PaymentTimedOut = 'PAYMENT_TIMED_OUT',
  CancellationRequested = 'CANCELLATION_REQUESTED',
}

/** What the saga writes into the history of an order without changing its status. */
export type SagaNote =
  | OrderEventType.StockReserved
  | OrderEventType.StockReleased
  | OrderEventType.PaymentTimedOut
  | OrderEventType.CancellationRequested;

/** The only allowed transitions. Anything else is `OrderInvalidTransitionError` (422). */
export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.Draft]: [OrderStatus.PendingPayment, OrderStatus.Cancelled],
  // back to DRAFT: the attempt ended before a charge was asked for (no stock, no answer).
  // CANCELLED: only when the saga of the attempt says that nothing was or will be charged;
  // the order cannot know, so `CancelOrderService` asks the saga first.
  [OrderStatus.PendingPayment]: [
    OrderStatus.Paid,
    OrderStatus.PaymentFailed,
    OrderStatus.Draft,
    OrderStatus.Cancelled,
  ],
  [OrderStatus.PaymentFailed]: [OrderStatus.PendingPayment, OrderStatus.Cancelled],
  [OrderStatus.Paid]: [OrderStatus.Fulfilled],
  [OrderStatus.Fulfilled]: [],
  [OrderStatus.Cancelled]: [],
};
