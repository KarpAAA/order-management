import { AggregateRoot } from '@shared/domain/aggregate-root';
import { newId } from '@shared/domain/id';
import { Money } from '@shared/domain/money';

import { NO_DISCOUNT } from './discount';
import {
  InvalidOrderError,
  OrderHasNoItemsError,
  OrderInvalidTransitionError,
  OrderNotEditableError,
  PaymentAttemptNotPendingError,
  ProductNotActiveError,
} from './errors';
import { OrderCancelled } from './events/order-cancelled.event';
import { OrderFulfilled } from './events/order-fulfilled.event';
import { OrderPaid } from './events/order-paid.event';
import { OrderPaymentFailed } from './events/order-payment-failed.event';
import { OrderPlaced } from './events/order-placed.event';
import { OrderReturnedToDraft } from './events/order-returned-to-draft.event';
import { OrderLine } from './order-line';
import { OrderEventType, OrderStatus, TRANSITIONS } from './order-status';
import { calculateTotals } from './order-totals';

import type { Discount } from './discount';
import type { OrderRef } from './events/order-ref';
import type { SagaNote } from './order-status';
import type { OrderTotals } from './order-totals';

export const MAX_LINES = 50;

/** A product as the caller wants it on the order, with the catalog data to snapshot. */
export interface OrderLineInput {
  productId: string;
  sku: string;
  name: string;
  unitPriceMinor: bigint;
  isActive: boolean;
  quantity: number;
}

/** A product an order asked more of than was free, as inventory reported it. */
export interface StockShortage {
  productId: string;
  requested: number;
  available: number;
}

type HistoryPayload = Record<string, string | number | readonly StockShortage[]>;

/** One row of the order history, written in the same transaction as the status change. */
export interface OrderHistoryEntry {
  id: string;
  type: OrderEventType;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  /** Opaque audit reference (user id or `system:<source>`); the domain never interprets it. */
  changedBy: string;
  payload: HistoryPayload;
  at: Date;
}

export interface OrderProps {
  workspaceId: string;
  id: string;
  status: OrderStatus;
  currency: string;
  discount: Discount;
  taxRateBps: number;
  lines: OrderLine[];
  paymentAttempt: number;
  pspChargeId: string | null;
  failureReason: string | null;
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  placedAt: Date | null;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  cancelledAt: Date | null;
}

interface Change {
  now: Date;
  changedBy: string;
}

export class Order extends AggregateRoot {
  private newHistory: OrderHistoryEntry[] = [];

  private constructor(private readonly props: OrderProps) {
    super();
  }

  static draft(input: {
    workspaceId: string;
    currency: string;
    taxRateBps: number;
    lines: readonly OrderLineInput[];
    discount?: Discount;
    createdBy: string;
    now: Date;
  }): Order {
    const order = new Order({
      workspaceId: input.workspaceId,
      id: newId(),
      status: OrderStatus.Draft,
      currency: input.currency,
      discount: input.discount ?? NO_DISCOUNT,
      taxRateBps: input.taxRateBps,
      lines: [],
      paymentAttempt: 0,
      pspChargeId: null,
      failureReason: null,
      version: 0,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
      placedAt: null,
      paidAt: null,
      fulfilledAt: null,
      cancelledAt: null,
    });
    order.props.lines = order.buildLines(input.lines);
    order.addHistory(OrderEventType.OrderCreated, null, {
      now: input.now,
      changedBy: input.createdBy,
    });
    return order;
  }

  static restore(props: OrderProps): Order {
    return new Order(props);
  }

  /** Replaces items and discount. DRAFT only. */
  replaceContents(input: {
    lines: readonly OrderLineInput[];
    discount: Discount;
    now: Date;
  }): void {
    if (this.props.status !== OrderStatus.Draft) {
      throw new OrderNotEditableError(this.id, this.props.status);
    }
    this.props.lines = this.buildLines(input.lines);
    this.props.discount = input.discount;
    this.props.updatedAt = input.now;
  }

  /** DRAFT or PAYMENT_FAILED → PENDING_PAYMENT; every call is a new payment attempt. */
  place(change: Change): void {
    if (this.props.lines.length === 0) throw new OrderHasNoItemsError(this.id);
    const from = this.transitionTo(OrderStatus.PendingPayment, 'place');
    this.props.paymentAttempt += 1;
    this.props.failureReason = null;
    this.props.placedAt = change.now;
    this.addHistory(OrderEventType.OrderPlaced, from, change, {
      paymentAttempt: this.props.paymentAttempt,
    });
    this.record(new OrderPlaced(this.ref, this.props.paymentAttempt, this.amountDue, change.now));
  }

  cancel(change: Change): void {
    const from = this.transitionTo(OrderStatus.Cancelled, 'cancel');
    this.props.cancelledAt = change.now;
    this.addHistory(OrderEventType.OrderCancelled, from, change);
    this.record(new OrderCancelled(this.ref, change.now));
  }

  fulfill(change: Change): void {
    const from = this.transitionTo(OrderStatus.Fulfilled, 'fulfill');
    this.props.fulfilledAt = change.now;
    this.addHistory(OrderEventType.OrderFulfilled, from, change);
    this.record(new OrderFulfilled(this.ref, change.now));
  }

  /**
   * PENDING_PAYMENT → DRAFT: the attempt ended before a charge was asked for. The stock was
   * not there (`shortages`), or inventory never said. The order can be changed and placed
   * again, which is a new attempt.
   */
  returnToDraft(
    input: Change & { attempt: number; reason: string; shortages?: readonly StockShortage[] },
  ): void {
    this.assertAwaitingPayment(input.attempt);
    // Stryker disable next-line StringLiteral: unreachable, assertAwaitingPayment guarantees PENDING_PAYMENT → DRAFT
    const from = this.transitionTo(OrderStatus.Draft, 'return to draft');
    this.props.failureReason = input.reason;
    this.props.placedAt = null;
    this.addHistory(OrderEventType.StockReservationFailed, from, input, {
      paymentAttempt: input.attempt,
      reason: input.reason,
      ...(input.shortages && { shortages: input.shortages }),
    });
    this.record(new OrderReturnedToDraft(this.ref, input.attempt, input.reason, input.now));
  }

  /**
   * A step of the saga of `attempt` that changes no status: a row of the history, from and
   * to the status the order has. No guard on the status: stock is released after the order
   * has left PENDING_PAYMENT, and maybe after it was placed again.
   */
  note(type: SagaNote, input: Change & { attempt: number }): void {
    this.addHistory(type, this.props.status, input, { paymentAttempt: input.attempt });
  }

  /** Guards a payment outcome: only the attempt the order is waiting for may be settled. */
  assertAwaitingPayment(attempt: number): void {
    if (this.props.status !== OrderStatus.PendingPayment || this.props.paymentAttempt !== attempt) {
      throw new PaymentAttemptNotPendingError(
        this.id,
        attempt,
        this.props.status,
        this.props.paymentAttempt,
      );
    }
  }

  markPaid(input: Change & { attempt: number; pspChargeId: string }): void {
    this.assertAwaitingPayment(input.attempt);
    // Stryker disable next-line StringLiteral: unreachable, assertAwaitingPayment guarantees PENDING_PAYMENT → PAID
    const from = this.transitionTo(OrderStatus.Paid, 'mark paid');
    this.props.pspChargeId = input.pspChargeId;
    this.props.paidAt = input.now;
    this.addHistory(OrderEventType.PaymentSucceeded, from, input, {
      paymentAttempt: input.attempt,
      pspChargeId: input.pspChargeId,
    });
    const { attempt, pspChargeId, now } = input;
    this.record(new OrderPaid(this.ref, attempt, pspChargeId, this.amountDue, now));
  }

  markPaymentFailed(input: Change & { attempt: number; reason: string }): void {
    this.assertAwaitingPayment(input.attempt);
    // Stryker disable next-line StringLiteral: unreachable, assertAwaitingPayment guarantees PENDING_PAYMENT → PAYMENT_FAILED
    const from = this.transitionTo(OrderStatus.PaymentFailed, 'mark payment failed');
    this.props.failureReason = input.reason;
    this.addHistory(OrderEventType.PaymentFailed, from, input, {
      paymentAttempt: input.attempt,
      reason: input.reason,
    });
    const { attempt, reason, now } = input;
    this.record(new OrderPaymentFailed(this.ref, attempt, reason, this.amountDue, now));
  }

  get id(): string {
    return this.props.id;
  }
  get workspaceId(): string {
    return this.props.workspaceId;
  }
  get status(): OrderStatus {
    return this.props.status;
  }
  get version(): number {
    return this.props.version;
  }
  get paymentAttempt(): number {
    return this.props.paymentAttempt;
  }
  get lines(): readonly OrderLine[] {
    return this.props.lines;
  }
  get totals(): OrderTotals {
    return calculateTotals({
      currency: this.props.currency,
      lineTotals: this.props.lines.map((line) => line.total),
      discount: this.props.discount,
      taxRateBps: this.props.taxRateBps,
    });
  }

  /** The amount to charge, in the order currency. */
  get amountDue(): Money {
    return this.totals.total;
  }

  snapshot(): Readonly<OrderProps> {
    return { ...this.props };
  }

  /** History entries recorded since load; the repository persists them with the order. */
  pullHistory(): OrderHistoryEntry[] {
    const entries = this.newHistory;
    this.newHistory = [];
    return entries;
  }

  /** What every event of the order starts with. */
  private get ref(): OrderRef {
    return { workspaceId: this.workspaceId, orderId: this.id, createdBy: this.props.createdBy };
  }

  private buildLines(inputs: readonly OrderLineInput[]): OrderLine[] {
    if (inputs.length > MAX_LINES) {
      throw new InvalidOrderError('An order has at most 50 items', { count: inputs.length });
    }
    const seen = new Set<string>();
    return inputs.map((input, position) => {
      if (seen.has(input.productId)) {
        throw new InvalidOrderError('A product may appear only once per order', {
          productId: input.productId,
        });
      }
      seen.add(input.productId);
      if (!input.isActive) throw new ProductNotActiveError(input.productId);
      return OrderLine.create({
        position,
        productId: input.productId,
        sku: input.sku,
        name: input.name,
        unitPrice: Money.of(input.unitPriceMinor, this.props.currency),
        quantity: input.quantity,
      });
    });
  }

  private transitionTo(next: OrderStatus, action: string): OrderStatus {
    const from = this.props.status;
    if (!TRANSITIONS[from].includes(next)) {
      throw new OrderInvalidTransitionError(this.id, action, from);
    }
    this.props.status = next;
    return from;
  }

  private addHistory(
    type: OrderEventType,
    from: OrderStatus | null,
    change: Change,
    payload: HistoryPayload = {},
  ): void {
    this.props.updatedAt = change.now;
    this.newHistory.push({
      id: newId(),
      type,
      fromStatus: from,
      toStatus: this.props.status,
      changedBy: change.changedBy,
      payload,
      at: change.now,
    });
  }
}
