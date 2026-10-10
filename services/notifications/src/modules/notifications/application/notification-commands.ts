import type { DeliveryPolicy, Recipient } from '../domain/notification';
import type { OrderNotice } from '../domain/order-notice';

export interface RequestNotificationCommand {
  workspaceId: string;
  recipient: Recipient;
  notice: OrderNotice;
  /** The chain of the event: kept with the notification, for the mail that goes out later. */
  correlationId: string;
}

/** How long one mail is tried: bound by the module from the configuration. */
export const DELIVERY_POLICY = Symbol('DELIVERY_POLICY');
export type { DeliveryPolicy };

/** What one pass of the dispatcher did. */
export type DispatchOutcome =
  /** Nothing is due: the dispatcher may sleep. */
  | 'idle'
  | 'sent'
  /** The try failed; the next one is due later. */
  | 'postponed'
  /** The try failed and no other follows. */
  | 'given-up';

/** The notification a pass tried: ids and counts, never the address or the text. */
export interface TriedNotification {
  id: string;
  orderId: string;
  kind: string;
  attempt: number;
  sendAttempts: number;
  correlationId: string | null;
}

/**
 * What one pass of the dispatcher did, for its caller to tell: the use case logs nothing.
 * `failure` says why a try failed without the text of the server, which names the address.
 */
export interface Dispatched {
  outcome: DispatchOutcome;
  notification?: TriedNotification;
  failure?: { retryable: boolean; smtpCode?: number };
}
