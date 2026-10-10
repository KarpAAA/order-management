import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Inject, Injectable } from '@nestjs/common';
import {
  exchanges,
  OrderCancelledV1,
  OrderFulfilledV1,
  OrderPaidV1,
  OrderPaymentFailedV1,
  OrderPlacedV1,
  OrderReturnedToDraftV1,
  parseMessage,
} from '@oms/contracts';

import { systemActor } from '@shared/auth/actor';
import { DomainError } from '@shared/errors/domain-error';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { INBOX, type Inbox } from '@shared/messaging/inbox';

import { RequestNotificationService } from '../../application/request-notification.service';

import type { OrderNotice } from '../../domain/order-notice';
import type { AnyMessage } from '@oms/contracts';

const ACTOR = systemActor('consumer:notifications');

/** The queue of this service on the `events` exchange: what happens to an order. */
const ORDER_EVENTS_QUEUE = 'notifications.order-events';

/**
 * Thin: validate the message against its contract, turn it into the notice it means, call
 * one use case, once per message: the inbox records the message in the transaction that
 * writes the notification, and a message that was recorded before is acknowledged without a
 * call (docs/adr/0015-idempotent-consumers.md).
 *
 * A notice is made of its own event and nothing else. The events of one order arrive in any
 * order (a redelivery returns behind the ones published meanwhile), so nothing here asks
 * what came before, and nothing is kept for an event that comes later.
 *
 * Returning acknowledges the message. Whatever is thrown is settled by the connection
 * (infrastructure/messaging/retry-or-park.ts): delivered again after a delay, or parked in
 * `notifications.order-events.dlq` when it is an `UnprocessableMessageError` or the last delivery.
 */
@Injectable()
export class OrderEventsConsumer {
  private readonly log: Logger;

  constructor(
    @Inject(INBOX) private readonly inbox: Inbox,
    private readonly requestNotification: RequestNotificationService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: OrderEventsConsumer.name });
  }

  // the queue's arguments and its retry policy are added by RabbitSubscribers, from the config
  @RabbitSubscribe({
    exchange: exchanges.events.name,
    routingKey: [
      OrderPlacedV1.name,
      OrderPaidV1.name,
      OrderCancelledV1.name,
      OrderFulfilledV1.name,
      OrderPaymentFailedV1.name,
      OrderReturnedToDraftV1.name,
    ],
    queue: ORDER_EVENTS_QUEUE,
  })
  async onOrderEvent(raw: unknown): Promise<void> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: another delivery cannot help
      throw new UnprocessableMessageError(`${parsed.reason}: ${parsed.detail}`);
    }
    const { message } = parsed;
    const cmd = {
      workspaceId: message.workspaceId,
      recipient: recipientOf(message),
      notice: noticeOf(message),
      // kept with the notification: its mail is sent later, outside the scope of this message
      correlationId: message.correlationId,
    };
    let fresh: boolean;
    try {
      fresh = await this.inbox.once(ORDER_EVENTS_QUEUE, message.messageId, () =>
        this.requestNotification.execute(cmd, ACTOR),
      );
    } catch (err: unknown) {
      // the database, a bug: the next delivery may pass
      if (!(err instanceof DomainError)) throw err;
      // business said no and will say it again
      throw new UnprocessableMessageError(`${err.code}: ${err.message}`, { cause: err });
    }
    if (!fresh) {
      // the same message again (the broker, the relay of the sender, an operator): done before
      this.log.info(
        { messageName: message.name, messageId: message.messageId, reason: 'duplicate' },
        'message skipped',
      );
    }
  }
}

/** What the event means to the user of the order, from the event alone. */
function noticeOf(message: AnyMessage): OrderNotice {
  const occurredAt = new Date(message.occurredAt);
  switch (message.name) {
    case OrderPlacedV1.name: {
      const { orderId, paymentAttempt, amount } = message.payload;
      return { kind: 'order-placed', orderId, occurredAt, paymentAttempt, amount };
    }
    case OrderPaidV1.name: {
      const { orderId, paymentAttempt, amount } = message.payload;
      return { kind: 'order-paid', orderId, occurredAt, paymentAttempt, amount };
    }
    case OrderCancelledV1.name:
      return { kind: 'order-cancelled', orderId: message.payload.orderId, occurredAt };
    case OrderFulfilledV1.name:
      return { kind: 'order-fulfilled', orderId: message.payload.orderId, occurredAt };
    case OrderPaymentFailedV1.name: {
      const { orderId, paymentAttempt, reason, amount } = message.payload;
      return { kind: 'order-payment-failed', orderId, occurredAt, paymentAttempt, reason, amount };
    }
    case OrderReturnedToDraftV1.name: {
      const { orderId, paymentAttempt, reason } = message.payload;
      return { kind: 'order-returned-to-draft', orderId, occurredAt, paymentAttempt, reason };
    }
    default:
      throw new UnprocessableMessageError(`${message.name} is not an event of this queue`);
  }
}

function recipientOf(message: AnyMessage): { userId: string; email: string } {
  if ('recipient' in message.payload) return message.payload.recipient;
  throw new UnprocessableMessageError(`${message.name} names no recipient`);
}
