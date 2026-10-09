import type { DeliveryPolicy, Recipient } from '../domain/notification';
import type { OrderNotice } from '../domain/order-notice';

export interface RequestNotificationCommand {
  workspaceId: string;
  recipient: Recipient;
  notice: OrderNotice;
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
