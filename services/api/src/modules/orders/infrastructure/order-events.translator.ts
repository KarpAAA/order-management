import { Injectable } from '@nestjs/common';
import {
  exchanges,
  OrderCancelledV1,
  OrderFulfilledV1,
  OrderPaidV1,
  OrderPlacedV1,
} from '@oms/contracts';

import { CorrelationContext } from '@common/messaging/correlation-context';
import type { OutboxEntry, OutboxEnvelope } from '@infra/outbox/outbox';
import { ReliableEvents } from '@infra/outbox/reliable-events';
import { newId } from '@shared/domain/id';

import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderFulfilled } from '../domain/events/order-fulfilled.event';
import { OrderPaid } from '../domain/events/order-paid.event';
import { OrderPlaced } from '../domain/events/order-placed.event';

import type { MessageMeta } from '@oms/contracts';

interface OrderEvent {
  workspaceId: string;
  occurredAt: Date;
}

/**
 * The reliable domain events of orders as the rest of the system reads them: the contracts
 * `orders.*` of `@oms/contracts`, published to the `events` exchange. The domain event stays
 * private to the module; what leaves the service is the contract (docs/adr/0011, 0014).
 */
@Injectable()
export class OrderEventsTranslator {
  constructor(
    private readonly correlation: CorrelationContext,
    reliable: ReliableEvents,
  ) {
    reliable.register(OrderPlaced, (event) =>
      this.toEvents(
        OrderPlacedV1.create(this.meta(event), {
          orderId: event.orderId,
          paymentAttempt: event.paymentAttempt,
          // a JSON number on the wire, as in the HTTP API; the contract refuses an unsafe one
          amount: {
            amountMinor: Number(event.amountDue.amountMinor),
            currency: event.amountDue.currency,
          },
        }),
      ),
    );
    reliable.register(OrderPaid, (event) =>
      this.toEvents(
        OrderPaidV1.create(this.meta(event), {
          orderId: event.orderId,
          paymentAttempt: event.paymentAttempt,
          chargeId: event.pspChargeId,
        }),
      ),
    );
    reliable.register(OrderCancelled, (event) =>
      this.toEvents(OrderCancelledV1.create(this.meta(event), { orderId: event.orderId })),
    );
    reliable.register(OrderFulfilled, (event) =>
      this.toEvents(OrderFulfilledV1.create(this.meta(event), { orderId: event.orderId })),
    );
  }

  private meta(event: OrderEvent): MessageMeta {
    return {
      messageId: newId(),
      occurredAt: event.occurredAt,
      workspaceId: event.workspaceId,
      correlationId: this.correlation.id(),
    };
  }

  private toEvents(message: OutboxEnvelope): OutboxEntry[] {
    return [{ exchange: exchanges.events.name, message }];
  }
}
