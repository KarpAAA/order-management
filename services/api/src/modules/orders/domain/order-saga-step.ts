/** Mirrors the Prisma enum `OrderSagaStep` one-to-one. */
export enum OrderSagaStep {
  /** `inventory.reserve-stock` was sent; waiting for the stock to be held or refused. */
  Reserving = 'RESERVING',
  /** The stock is held and `payments.charge-payment` was sent; waiting for the outcome. */
  Charging = 'CHARGING',
  /** `payments.cancel-payment` was sent; waiting to learn how the attempt ended. */
  CancellingPayment = 'CANCELLING_PAYMENT',
  /** The compensation: `inventory.release-stock` was sent; waiting for its answer. */
  Releasing = 'RELEASING',
  /** The order is paid. */
  Completed = 'COMPLETED',
  /** Ended without a payment, and whatever was held is given back. */
  Aborted = 'ABORTED',
}

/** A step that waits for an answer, and so has a timeout. */
export type WaitingStep =
  | OrderSagaStep.Reserving
  | OrderSagaStep.Charging
  | OrderSagaStep.CancellingPayment
  | OrderSagaStep.Releasing;

export const WAITING_STEPS: readonly WaitingStep[] = [
  OrderSagaStep.Reserving,
  OrderSagaStep.Charging,
  OrderSagaStep.CancellingPayment,
  OrderSagaStep.Releasing,
];

/** What a request to cancel the order means while its saga is in a given step. */
export type CancelDecision =
  /** No charge was asked for: the order is cancelled now, and whatever is held is released. */
  | 'cancel-now'
  /** A charge is under way: payments is asked not to make it, and its answer decides. */
  | 'cancel-payment'
  /** Payments was asked already (a timeout): the request is remembered for its answer. */
  | 'remember'
  /** The request is known: nothing to do. */
  | 'already-requested';

/** What is to be sent when a step was not answered in time. */
export type TimeoutAction =
  /** Inventory never said: give back whatever it may hold. */
  | 'release-stock'
  /** Payments never said: ask it not to charge, and wait for how the attempt ended. */
  | 'cancel-payment'
  /** The question is still open: ask again. Nothing may be decided without the answer. */
  | 'repeat-cancel-payment'
  | 'repeat-release-stock';
