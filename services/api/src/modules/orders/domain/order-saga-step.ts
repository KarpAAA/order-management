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

/** What is to be sent when a step was not answered in time. */
export type TimeoutAction =
  /** Inventory never said: give back whatever it may hold. */
  | 'release-stock'
  /** Payments never said: ask it not to charge, and wait for how the attempt ended. */
  | 'cancel-payment'
  /** The question is still open: ask again. Nothing may be decided without the answer. */
  | 'repeat-cancel-payment'
  | 'repeat-release-stock';
