import { newId } from '@shared/domain/id';

import { NotificationNotPendingError } from './errors';
import { NotificationStatus } from './notification-status';
import { attemptOf } from './order-notice';
import { render } from './templates';

import type { NotificationKind, OrderNotice } from './order-notice';

export interface Recipient {
  userId: string;
  email: string;
}

/** How long the service keeps trying one mail. */
export interface DeliveryPolicy {
  /** Tries in all; the one that reaches this number is the last. */
  maxSendAttempts: number;
  /** The wait after the first failed try; it doubles with every next one. */
  retryDelayMs: number;
}

export interface NotificationProps {
  id: string;
  workspaceId: string;
  orderId: string;
  kind: NotificationKind;
  /** Which placing of the order; 0 for what happens to an order once. */
  attempt: number;
  recipient: Recipient;
  subject: string;
  body: string;
  status: NotificationStatus;
  /** Tries so far, the successful one included. */
  sendAttempts: number;
  /** PENDING only: not before this moment. */
  nextAttemptAt: Date | null;
  lastError: string | null;
  occurredAt: Date;
  /** The chain of the event that asked for it; null for one written before it was kept. */
  correlationId: string | null;
  /**
   * The trace of the event that asked for it, as the repository kept it with the row: opaque
   * here, handed to the mailer with the mail. Null at birth, and for a row written outside a
   * trace (docs/adr/0025).
   */
  traceContext: Readonly<Record<string, string>> | null;
  createdAt: Date;
  /** SENT or FAILED: when. */
  settledAt: Date | null;
}

/**
 * A mail the service owes a user about one fact of one order. It is written when the event
 * arrives, in the transaction that records the event, and sent afterwards:
 *
 *   (new) PENDING → SENT
 *         PENDING → PENDING     a try failed, the next one is due later
 *         PENDING → FAILED      the server refused it for good, or every try failed
 *
 * `(orderId, kind, attempt)` names the fact: a second notification about it is not written.
 * The text is rendered at birth, from the notice alone: what is sent is what was owed then.
 */
export class Notification {
  private constructor(private readonly props: NotificationProps) {}

  static request(input: {
    workspaceId: string;
    recipient: Recipient;
    notice: OrderNotice;
    correlationId: string | null;
    now: Date;
  }): Notification {
    const { notice, now } = input;
    return new Notification({
      id: newId(),
      workspaceId: input.workspaceId,
      orderId: notice.orderId,
      kind: notice.kind,
      attempt: attemptOf(notice),
      recipient: { ...input.recipient },
      ...render(notice),
      status: NotificationStatus.Pending,
      sendAttempts: 0,
      nextAttemptAt: now,
      lastError: null,
      occurredAt: notice.occurredAt,
      correlationId: input.correlationId,
      traceContext: null,
      createdAt: now,
      settledAt: null,
    });
  }

  static restore(props: NotificationProps): Notification {
    return new Notification(props);
  }

  /** PENDING → SENT: the mail server took it. */
  markSent(now: Date): void {
    this.assertPending();
    this.props.sendAttempts += 1;
    this.settle(NotificationStatus.Sent, now);
  }

  /**
   * A try failed. `permanent`: the server said no and will say it again (an address it does
   * not accept), so nothing is tried again. Otherwise the next try is due after a wait that
   * doubles each time, until the last one.
   */
  markSendFailed(input: {
    error: string;
    permanent: boolean;
    now: Date;
    policy: DeliveryPolicy;
  }): void {
    this.assertPending();
    const { now, policy } = input;
    this.props.sendAttempts += 1;
    this.props.lastError = input.error;
    if (input.permanent || this.props.sendAttempts >= policy.maxSendAttempts) {
      this.settle(NotificationStatus.Failed, now);
      return;
    }
    const wait = policy.retryDelayMs * 2 ** (this.props.sendAttempts - 1);
    this.props.nextAttemptAt = new Date(now.getTime() + wait);
  }

  get id(): string {
    return this.props.id;
  }
  get workspaceId(): string {
    return this.props.workspaceId;
  }
  get orderId(): string {
    return this.props.orderId;
  }
  get kind(): NotificationKind {
    return this.props.kind;
  }
  get attempt(): number {
    return this.props.attempt;
  }
  get status(): NotificationStatus {
    return this.props.status;
  }
  get recipient(): Readonly<Recipient> {
    return this.props.recipient;
  }
  get subject(): string {
    return this.props.subject;
  }
  get body(): string {
    return this.props.body;
  }
  get sendAttempts(): number {
    return this.props.sendAttempts;
  }
  get correlationId(): string | null {
    return this.props.correlationId;
  }
  get traceContext(): Readonly<Record<string, string>> | null {
    return this.props.traceContext;
  }
  /** Nobody will try again: somebody has to look. */
  get givenUp(): boolean {
    return this.props.status === NotificationStatus.Failed;
  }

  snapshot(): Readonly<NotificationProps> {
    return { ...this.props, recipient: { ...this.props.recipient } };
  }

  private assertPending(): void {
    if (this.props.status !== NotificationStatus.Pending) {
      throw new NotificationNotPendingError(this.id, this.props.status);
    }
  }

  private settle(status: NotificationStatus.Sent | NotificationStatus.Failed, now: Date): void {
    this.props.status = status;
    this.props.nextAttemptAt = null;
    this.props.settledAt = now;
  }
}
