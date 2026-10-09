/** Money as an event carries it: minor units and an ISO 4217 code. */
export interface NoticeMoney {
  amountMinor: number;
  currency: string;
}

interface About {
  orderId: string;
  /** When the fact happened, as the event said: not when it arrived, nor when the mail left. */
  occurredAt: Date;
}

/**
 * What the user of an order is told, one variant per event. Each carries everything its mail
 * says: events of one order arrive in any order, so a notice never needs what another event
 * knew (docs/adr/0019-notifications-service.md).
 */
export type OrderNotice =
  | (About & { kind: 'order-placed'; paymentAttempt: number; amount: NoticeMoney })
  | (About & { kind: 'order-paid'; paymentAttempt: number; amount: NoticeMoney })
  | (About & { kind: 'order-cancelled' })
  | (About & { kind: 'order-fulfilled' })
  | (About & {
      kind: 'order-payment-failed';
      paymentAttempt: number;
      reason: string;
      amount: NoticeMoney;
    })
  | (About & { kind: 'order-returned-to-draft'; paymentAttempt: number; reason: string });

export type NotificationKind = OrderNotice['kind'];

/**
 * Which placing of the order the notice is about; 0 for what happens to an order once.
 * With the order and the kind it names the fact: one notification per fact.
 */
export const attemptOf = (notice: OrderNotice): number =>
  'paymentAttempt' in notice ? notice.paymentAttempt : 0;
