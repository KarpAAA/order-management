/** Mirrors the Prisma enum `OrderStatus` one-to-one. */
export enum OrderStatus {
  Draft = 'DRAFT',
  PendingPayment = 'PENDING_PAYMENT',
  Paid = 'PAID',
  PaymentFailed = 'PAYMENT_FAILED',
  Fulfilled = 'FULFILLED',
  Cancelled = 'CANCELLED',
}

/** Mirrors the Prisma enum `OrderEventType`: one entry per status change. */
export enum OrderEventType {
  OrderCreated = 'ORDER_CREATED',
  OrderPlaced = 'ORDER_PLACED',
  PaymentSucceeded = 'PAYMENT_SUCCEEDED',
  PaymentFailed = 'PAYMENT_FAILED',
  OrderFulfilled = 'ORDER_FULFILLED',
  OrderCancelled = 'ORDER_CANCELLED',
}

/** The only allowed transitions. Anything else is `OrderInvalidTransitionError` (422). */
export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.Draft]: [OrderStatus.PendingPayment, OrderStatus.Cancelled],
  [OrderStatus.PendingPayment]: [OrderStatus.Paid, OrderStatus.PaymentFailed],
  [OrderStatus.PaymentFailed]: [OrderStatus.PendingPayment, OrderStatus.Cancelled],
  [OrderStatus.Paid]: [OrderStatus.Fulfilled],
  [OrderStatus.Fulfilled]: [],
  [OrderStatus.Cancelled]: [],
};
