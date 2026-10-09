import { Inject, Injectable } from '@nestjs/common';
import {
  exchanges,
  OrderCancelledV1,
  OrderFulfilledV1,
  OrderPaidV1,
  OrderPaymentFailedV1,
  OrderPlacedV1,
  OrderReturnedToDraftV1,
} from '@oms/contracts';

import { CorrelationContext } from '@common/messaging/correlation-context';
import type { OutboxEntry, OutboxEnvelope } from '@infra/outbox/outbox';
import { ReliableEvents } from '@infra/outbox/reliable-events';
import { newId } from '@shared/domain/id';
import type { Money } from '@shared/domain/money';

import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderFulfilled } from '../domain/events/order-fulfilled.event';
import { OrderPaid } from '../domain/events/order-paid.event';
import { OrderPaymentFailed } from '../domain/events/order-payment-failed.event';
import { OrderPlaced } from '../domain/events/order-placed.event';
import { OrderReturnedToDraft } from '../domain/events/order-returned-to-draft.event';
import { ORDER_RECIPIENTS, type OrderRecipients } from '../ports/order-recipients.port';

import type { OrderRef } from '../domain/events/order-ref';
import type { MessageMeta, Money as WireMoney, Recipient } from '@oms/contracts';

interface OrderEvent {
  order: OrderRef;
  occurredAt: Date;
}

/** What every contract of an order starts with: which order, and whom the message is for. */
interface Addressed {
  orderId: string;
  recipient: Recipient;
}

// a JSON number on the wire, as in the HTTP API; the contract refuses an unsafe one
const toWire = (money: Money): WireMoney => ({
  amountMinor: Number(money.amountMinor),
  currency: money.currency,
});

/**
 * The reliable domain events of orders as the rest of the system reads them: the contracts
 * `orders.*` of `@oms/contracts`, published to the `events` exchange. The domain event stays
 * private to the module; what leaves the service is the contract (docs/adr/0011, 0014).
 *
 * Every contract carries its recipient, the user who created the order: a subscriber that
 * writes to them reads nothing but the event (docs/adr/0019). The order knows the id of
 * that user; the address is asked for here, so it never enters the domain of orders.
 */
@Injectable()
export class OrderEventsTranslator {
  constructor(
    private readonly correlation: CorrelationContext,
    @Inject(ORDER_RECIPIENTS) private readonly recipients: OrderRecipients,
    reliable: ReliableEvents,
  ) {
    reliable.register(OrderPlaced, async (event) => {
      const { paymentAttempt } = event;
      const amount = toWire(event.amountDue);
      const payload = { ...(await this.addressed(event)), paymentAttempt, amount };
      return this.toEvents(OrderPlacedV1.create(this.meta(event), payload));
    });
    reliable.register(OrderPaid, async (event) => {
      const { paymentAttempt, pspChargeId: chargeId } = event;
      const amount = toWire(event.amountDue);
      const payload = { ...(await this.addressed(event)), paymentAttempt, chargeId, amount };
      return this.toEvents(OrderPaidV1.create(this.meta(event), payload));
    });
    reliable.register(OrderCancelled, async (event) =>
      this.toEvents(OrderCancelledV1.create(this.meta(event), await this.addressed(event))),
    );
    reliable.register(OrderFulfilled, async (event) =>
      this.toEvents(OrderFulfilledV1.create(this.meta(event), await this.addressed(event))),
    );
    reliable.register(OrderPaymentFailed, async (event) => {
      const { paymentAttempt, reason } = event;
      const amount = toWire(event.amountDue);
      const payload = { ...(await this.addressed(event)), paymentAttempt, reason, amount };
      return this.toEvents(OrderPaymentFailedV1.create(this.meta(event), payload));
    });
    reliable.register(OrderReturnedToDraft, async (event) => {
      const { paymentAttempt, reason } = event;
      const payload = { ...(await this.addressed(event)), paymentAttempt, reason };
      return this.toEvents(OrderReturnedToDraftV1.create(this.meta(event), payload));
    });
  }

  private meta(event: OrderEvent): MessageMeta {
    return {
      messageId: newId(),
      occurredAt: event.occurredAt,
      workspaceId: event.order.workspaceId,
      correlationId: this.correlation.id(),
    };
  }

  private async addressed({ order }: OrderEvent): Promise<Addressed> {
    return { orderId: order.orderId, recipient: await this.recipients.of(order.createdBy) };
  }

  private toEvents(message: OutboxEnvelope): OutboxEntry[] {
    return [{ exchange: exchanges.events.name, message }];
  }
}
