import { Inject, Injectable } from '@nestjs/common';

import { EventMeters } from '@infra/events/event-meters';
import { METRICS, type Metrics } from '@shared/observability/metrics';

import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderFulfilled } from '../domain/events/order-fulfilled.event';
import { OrderPaid } from '../domain/events/order-paid.event';
import { OrderPaymentFailed } from '../domain/events/order-payment-failed.event';
import { OrderPlaced } from '../domain/events/order-placed.event';
import { OrderReturnedToDraft } from '../domain/events/order-returned-to-draft.event';

export type PaymentFailureCause =
  'declined' | 'provider_unavailable' | 'provider_rejected' | 'timeout';

/**
 * Why a payment failed, as a label. The reason of the event is the decline code of the
 * provider, whatever the provider writes there: an open set, and every new value of a label
 * is a new time series. So the reasons we give ourselves are named, and everything else is
 * the provider saying no, which is one value.
 *
 * `declined` is the system working (the card was refused); the others are the system
 * failing its user, and they are what the SLO of `place` counts (docs/adr/0028).
 */
export function paymentFailureCause(reason: string): PaymentFailureCause {
  switch (reason) {
    case 'psp_unavailable':
      return 'provider_unavailable';
    case 'psp_rejected':
      return 'provider_rejected';
    case 'expired':
    case 'payment_timeout':
      return 'timeout';
    default:
      return 'declined';
  }
}

export type ReturnToDraftCause = 'out_of_stock' | 'inventory_unavailable' | 'other';

export function returnToDraftCause(reason: string): ReturnToDraftCause {
  return reason === 'out_of_stock' || reason === 'inventory_unavailable' ? reason : 'other';
}

/**
 * The business metrics of orders (docs/adr/0027): how many orders were placed, and how each
 * attempt ended. Counted from the domain events, after the commit, so no use case counts
 * and an order is counted where its status is decided.
 *
 * No label names a workspace, an order or a user: with thousands of tenants every metric
 * would be thousands of series. Which tenant is a question for the logs and the traces.
 */
@Injectable()
export class OrderEventsMeter {
  constructor(@Inject(METRICS) metrics: Metrics, meters: EventMeters) {
    const counter = (name: string, help: string) => metrics.counter({ name, help });
    const placed = counter('orders_placed_total', 'Orders placed: a payment attempt began.');
    const paid = counter('orders_paid_total', 'Payment attempts that ended with the order paid.');
    const cancelled = counter('orders_cancelled_total', 'Orders cancelled.');
    const fulfilled = counter('orders_fulfilled_total', 'Orders fulfilled.');
    const paymentFailed = metrics.counter({
      name: 'orders_payment_failed_total',
      help: 'Payment attempts that ended without a charge, by cause.',
      labels: ['cause'],
    });
    const returnedToDraft = metrics.counter({
      name: 'orders_returned_to_draft_total',
      help: 'Attempts that ended before a charge was asked for, by cause.',
      labels: ['cause'],
    });

    meters.register(OrderPlaced, () => {
      placed.inc({});
    });
    meters.register(OrderPaid, () => {
      paid.inc({});
    });
    meters.register(OrderCancelled, () => {
      cancelled.inc({});
    });
    meters.register(OrderFulfilled, () => {
      fulfilled.inc({});
    });
    meters.register(OrderPaymentFailed, (event) => {
      paymentFailed.inc({ cause: paymentFailureCause(event.reason) });
    });
    meters.register(OrderReturnedToDraft, (event) => {
      returnedToDraft.inc({ cause: returnToDraftCause(event.reason) });
    });
  }
}
