import { describe, expect, it } from 'vitest';

import { DomainEventPublisher } from '@infra/events/domain-event.publisher';
import { EventMeters } from '@infra/events/event-meters';
import { recordingOutbox } from '@infra/outbox/__test__/recording-outbox';
import { ReliableEvents } from '@infra/outbox/reliable-events';
import { Money } from '@shared/domain/money';
import type { DomainEvent } from '@shared/events/domain-event';
import { runInUnitOfWork } from '@shared/events/unit-of-work';
import { RecordingMetrics } from '@shared/observability/__test__/recording-metrics';

import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderFulfilled } from '../domain/events/order-fulfilled.event';
import { OrderPaid } from '../domain/events/order-paid.event';
import { OrderPaymentFailed } from '../domain/events/order-payment-failed.event';
import { OrderPlaced } from '../domain/events/order-placed.event';
import { OrderReturnedToDraft } from '../domain/events/order-returned-to-draft.event';

import { OrderEventsMeter, paymentFailureCause, returnToDraftCause } from './order-events.meter';

import type { EventBus } from '@nestjs/cqrs';

const AT = new Date('2026-10-10T10:00:00.000Z');
const ORDER = { workspaceId: 'w-1', orderId: 'o-1', createdBy: 'u-1' };
const DUE = Money.of(1500n, 'USD');

const placed = () => new OrderPlaced(ORDER, 1, DUE, AT);
const failed = (reason: string) => new OrderPaymentFailed(ORDER, 1, reason, DUE, AT);
const toDraft = (reason: string) => new OrderReturnedToDraft(ORDER, 1, reason, AT);

/** The publisher of the process with the meter of orders, and every event translated to nothing. */
function publishing() {
  const metrics = new RecordingMetrics();
  const meters = new EventMeters();
  new OrderEventsMeter(metrics, meters);
  const reliable = new ReliableEvents();
  for (const event of [
    OrderPlaced,
    OrderPaid,
    OrderCancelled,
    OrderFulfilled,
    OrderPaymentFailed,
    OrderReturnedToDraft,
  ]) {
    reliable.register<DomainEvent>(event, () => Promise.resolve([]));
  }
  const publisher = new DomainEventPublisher(
    { publish: () => undefined } as unknown as EventBus,
    reliable,
    recordingOutbox().outbox,
    meters,
  );
  const publish = (...events: DomainEvent[]) => runInUnitOfWork(() => publisher.publishAll(events));
  return { metrics, publisher, publish };
}

describe('the business metrics of orders (docs/adr/0027)', () => {
  it('MET-020 counts every event of an order once, under its own name', async () => {
    const { metrics, publish } = publishing();

    await publish(
      placed(),
      new OrderPaid(ORDER, 1, 'ch_1', DUE, AT),
      new OrderCancelled(ORDER, AT),
      new OrderFulfilled(ORDER, AT),
    );

    for (const name of ['placed', 'paid', 'cancelled', 'fulfilled']) {
      expect(metrics.total(`orders_${name}_total`), name).toBe(1);
    }
  });

  it('MET-020 counts after the commit: nothing while the transaction is open', async () => {
    const { metrics, publisher } = publishing();

    await runInUnitOfWork(async () => {
      await publisher.publishAll([placed()]);
      expect(metrics.total('orders_placed_total')).toBe(0);
    });

    expect(metrics.total('orders_placed_total')).toBe(1);
  });

  it('MET-020 counts nothing for a write that was rolled back', async () => {
    const { metrics, publisher } = publishing();

    await runInUnitOfWork(async () => {
      await publisher.publishAll([placed()]);
      throw new Error('the version is stale');
    }).catch(() => undefined);

    expect(metrics.total('orders_placed_total')).toBe(0);
  });

  it('MET-021 counts a failed payment by its cause', async () => {
    const { metrics, publish } = publishing();

    await publish(failed('psp_unavailable'), failed('card_declined'), failed('expired'));

    const causes = metrics.of('orders_payment_failed_total').map((sample) => sample.labels.cause);
    expect(causes).toEqual(['provider_unavailable', 'declined', 'timeout']);
  });

  it('MET-021 counts an attempt that never reached a charge by its cause', async () => {
    const { metrics, publish } = publishing();

    await publish(toDraft('out_of_stock'), toDraft('inventory_unavailable'));

    const causes = metrics
      .of('orders_returned_to_draft_total')
      .map((sample) => sample.labels.cause);
    expect(causes).toEqual(['out_of_stock', 'inventory_unavailable']);
  });
});

describe('the cause of a failure as a label (MET-022)', () => {
  it.each([
    ['psp_unavailable', 'provider_unavailable'],
    ['psp_rejected', 'provider_rejected'],
    ['expired', 'timeout'],
    ['payment_timeout', 'timeout'],
    ['card_declined', 'declined'],
    ['insufficient_funds', 'declined'],
  ])('%s → %s', (reason, cause) => {
    expect(paymentFailureCause(reason)).toBe(cause);
  });

  it('gives whatever a provider may write one value: a reason never becomes a new series', () => {
    const reasons = ['do_not_honor', '', 'ERR 51: ' + 'x'.repeat(200), crypto.randomUUID()];

    expect(new Set(reasons.map(paymentFailureCause))).toEqual(new Set(['declined']));
    expect(new Set(reasons.map(returnToDraftCause))).toEqual(new Set(['other']));
  });
});
