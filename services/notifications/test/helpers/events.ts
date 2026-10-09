// The events of an order as the api publishes them, built with the contracts: a test cannot
// send what the api could not. Every call is a new message (its own `messageId`): a test
// about the same message twice publishes one object twice.
import { randomUUID } from 'node:crypto';

import {
  OrderCancelledV1,
  OrderFulfilledV1,
  OrderPaidV1,
  OrderPaymentFailedV1,
  OrderPlacedV1,
  OrderReturnedToDraftV1,
} from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';

import { ACCEPTED_DOMAIN } from '../setup/mailpit';

import type { AnyMessage } from '@oms/contracts';

export const WORKSPACE = '01950000-0000-7000-8000-00000000a001';
export const AMOUNT = { amountMinor: 12_990, currency: 'EUR' };
/** When the facts of a test happened: not "now", so a mail that says it is recognizable. */
export const OCCURRED_AT = new Date('2026-03-04T05:06:00.000Z');

export interface Recipient {
  userId: string;
  email: string;
}

/** A user nobody else in the run writes to: the mail server is shared, the address is not. */
export const newRecipient = (domain = ACCEPTED_DOMAIN): Recipient => ({
  userId: uuidv7(),
  email: `user-${randomUUID()}@${domain}`,
});

export const newOrderId = (): string => uuidv7();

export interface About {
  orderId: string;
  recipient: Recipient;
  workspaceId?: string;
  paymentAttempt?: number;
}

const meta = ({ workspaceId = WORKSPACE }: About) => ({
  messageId: uuidv7(),
  occurredAt: OCCURRED_AT,
  workspaceId,
  correlationId: uuidv7(),
});

export const orderPlaced = (about: About): OrderPlacedV1 =>
  OrderPlacedV1.create(meta(about), {
    orderId: about.orderId,
    paymentAttempt: about.paymentAttempt ?? 1,
    amount: AMOUNT,
    recipient: about.recipient,
  });

export const orderPaid = (about: About): OrderPaidV1 =>
  OrderPaidV1.create(meta(about), {
    orderId: about.orderId,
    paymentAttempt: about.paymentAttempt ?? 1,
    chargeId: 'ch_1',
    amount: AMOUNT,
    recipient: about.recipient,
  });

export const orderCancelled = (about: About): OrderCancelledV1 =>
  OrderCancelledV1.create(meta(about), { orderId: about.orderId, recipient: about.recipient });

export const orderFulfilled = (about: About): OrderFulfilledV1 =>
  OrderFulfilledV1.create(meta(about), { orderId: about.orderId, recipient: about.recipient });

export const orderPaymentFailed = (about: About, reason = 'card_declined'): OrderPaymentFailedV1 =>
  OrderPaymentFailedV1.create(meta(about), {
    orderId: about.orderId,
    paymentAttempt: about.paymentAttempt ?? 1,
    reason,
    amount: AMOUNT,
    recipient: about.recipient,
  });

export const orderReturnedToDraft = (
  about: About,
  reason = 'out_of_stock',
): OrderReturnedToDraftV1 =>
  OrderReturnedToDraftV1.create(meta(about), {
    orderId: about.orderId,
    paymentAttempt: about.paymentAttempt ?? 1,
    reason,
    recipient: about.recipient,
  });

/** One event of every kind, with the kind of notification and the subject it becomes. */
export const EVERY_EVENT: readonly {
  kind: string;
  subject: string;
  build: (about: About) => AnyMessage;
}[] = [
  { kind: 'order-placed', subject: 'We received your order', build: orderPlaced },
  { kind: 'order-paid', subject: 'Your order is paid', build: orderPaid },
  { kind: 'order-cancelled', subject: 'Your order was cancelled', build: orderCancelled },
  { kind: 'order-fulfilled', subject: 'Your order was fulfilled', build: orderFulfilled },
  {
    kind: 'order-payment-failed',
    subject: 'The payment for your order did not go through',
    build: orderPaymentFailed,
  },
  {
    kind: 'order-returned-to-draft',
    subject: 'Your order could not be placed',
    build: orderReturnedToDraft,
  },
];
