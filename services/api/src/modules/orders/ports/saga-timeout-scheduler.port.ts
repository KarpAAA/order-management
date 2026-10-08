import type { WaitingStep } from '../domain/order-saga-step';

export const SAGA_TIMEOUT_SCHEDULER = Symbol('SAGA_TIMEOUT_SCHEDULER');

export interface SagaStepTimeout {
  workspaceId: string;
  orderId: string;
  attempt: number;
  /** The step that begins now and is to be answered before the timeout. */
  step: WaitingStep;
}

/**
 * "Tell me when this step has waited long enough." The timeout comes back as a message
 * (`interface/worker/saga-timeouts.consumer.ts`) whether the step was answered or not: the
 * saga decides whether it still counts.
 *
 * Called inside the transaction of the use case, like the commands of the step: a step never
 * begins to wait without its timeout (an outbox row, published with a delay).
 */
export interface SagaTimeoutScheduler {
  /** Returns the moment the timeout goes off: the deadline of the step. */
  schedule(timeout: SagaStepTimeout): Promise<Date>;
}
