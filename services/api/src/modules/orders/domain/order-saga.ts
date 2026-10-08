import { OrderSagaNotWaitingError } from './errors';
import { OrderSagaStep, WAITING_STEPS } from './order-saga-step';

import type { TimeoutAction, WaitingStep } from './order-saga-step';

export interface OrderSagaProps {
  workspaceId: string;
  orderId: string;
  /** `paymentAttempt` of the order: every placing is a saga of its own. */
  attempt: number;
  step: OrderSagaStep;
  /** Until when the current step waits for its answer; null once the saga has ended. */
  deadlineAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The process of one placing of an order across inventory and payments
 * (docs/adr/0017-order-saga.md):
 *
 *   RESERVING ──reserved──► CHARGING ──succeeded──► COMPLETED
 *       │ refused               │ failed ──────────────────────┐
 *       ▼                       │ timeout                      ▼
 *    ABORTED                    ▼                          RELEASING ──released──► ABORTED
 *                       CANCELLING_PAYMENT ──cancelled / failed─┘
 *                               └──succeeded──► COMPLETED
 *
 * It holds where the process is, and nothing else: what the order becomes is the order's
 * rule, what is sent is the use case's work. Every method but `waitUntil` is one fact that arrived (an
 * answer, a timeout); a fact the saga is not waiting for is an `InvalidStateError`, which a
 * consumer acknowledges. That is what makes a late answer, an answer given twice and an
 * answer for an earlier attempt harmless.
 */
export class OrderSaga {
  private constructor(private readonly props: OrderSagaProps) {}

  static start(input: {
    workspaceId: string;
    orderId: string;
    attempt: number;
    now: Date;
    /** When the timeout of the first step goes off. */
    deadline: Date;
  }): OrderSaga {
    return new OrderSaga({
      workspaceId: input.workspaceId,
      orderId: input.orderId,
      attempt: input.attempt,
      step: OrderSagaStep.Reserving,
      deadlineAt: input.deadline,
      version: 0,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: OrderSagaProps): OrderSaga {
    return new OrderSaga(props);
  }

  /** The stock is held: the charge may be asked for. */
  stockReserved(now: Date): void {
    this.leave([OrderSagaStep.Reserving], 'stock reserved');
    this.waitIn(OrderSagaStep.Charging, now);
  }

  /** Nothing is held and nothing was charged: there is nothing to give back. */
  stockRefused(now: Date): void {
    this.leave([OrderSagaStep.Reserving], 'stock refused');
    this.end(OrderSagaStep.Aborted, now);
  }

  /** The pivot: after it nothing is compensated. Also the answer to a cancellation that came too late. */
  paymentSucceeded(now: Date): void {
    this.leave([OrderSagaStep.Charging, OrderSagaStep.CancellingPayment], 'payment succeeded');
    this.end(OrderSagaStep.Completed, now);
  }

  /** Declined, expired or cancelled: no money was taken, so the stock goes back. */
  paymentEnded(now: Date): void {
    this.leave([OrderSagaStep.Charging, OrderSagaStep.CancellingPayment], 'payment ended');
    this.waitIn(OrderSagaStep.Releasing, now);
  }

  stockReleased(now: Date): void {
    this.leave([OrderSagaStep.Releasing], 'stock released');
    this.end(OrderSagaStep.Aborted, now);
  }

  /**
   * The timeout of `step` went off. It counts only while the saga is still in that step: an
   * answer that came first has moved it on, and the timeout is then a fact nobody waits for.
   */
  timedOut(step: WaitingStep, now: Date): TimeoutAction {
    this.leave([step], `timeout of ${step}`);
    switch (step) {
      case OrderSagaStep.Reserving:
        this.waitIn(OrderSagaStep.Releasing, now);
        return 'release-stock';
      case OrderSagaStep.Charging:
        this.waitIn(OrderSagaStep.CancellingPayment, now);
        return 'cancel-payment';
      case OrderSagaStep.CancellingPayment:
        this.waitIn(step, now);
        return 'repeat-cancel-payment';
      case OrderSagaStep.Releasing:
        this.waitIn(step, now);
        return 'repeat-release-stock';
    }
  }

  /**
   * Until when the step that has just begun waits: the moment its timeout goes off. Set
   * once the timeout is written, which comes after the saga has accepted the fact.
   */
  waitUntil(deadline: Date): void {
    if (!WAITING_STEPS.some((step) => step === this.props.step)) {
      throw new OrderSagaNotWaitingError(this.orderId, this.attempt, 'a deadline', this.props.step);
    }
    this.props.deadlineAt = deadline;
  }

  /** The step the saga waits in, or null once it has ended. */
  get waitingIn(): WaitingStep | null {
    return WAITING_STEPS.find((step) => step === this.props.step) ?? null;
  }

  get workspaceId(): string {
    return this.props.workspaceId;
  }
  get orderId(): string {
    return this.props.orderId;
  }
  get attempt(): number {
    return this.props.attempt;
  }
  get step(): OrderSagaStep {
    return this.props.step;
  }
  get version(): number {
    return this.props.version;
  }
  /** Until when the step waits; null before the timeout of a new step is written, and at the end. */
  get deadlineAt(): Date | null {
    return this.props.deadlineAt;
  }

  snapshot(): Readonly<OrderSagaProps> {
    return { ...this.props };
  }

  private leave(expected: readonly OrderSagaStep[], fact: string): void {
    if (!expected.includes(this.props.step)) {
      throw new OrderSagaNotWaitingError(this.orderId, this.attempt, fact, this.props.step);
    }
  }

  /** The deadline of the new step follows through `waitUntil()`. */
  private waitIn(step: WaitingStep, now: Date): void {
    this.props.step = step;
    this.props.deadlineAt = null;
    this.props.updatedAt = now;
  }

  private end(step: OrderSagaStep.Completed | OrderSagaStep.Aborted, now: Date): void {
    this.props.step = step;
    this.props.deadlineAt = null;
    this.props.updatedAt = now;
  }
}
