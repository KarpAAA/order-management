// The metrics of the service (MET-052, docs/adr/0027): what Prometheus would read after a
// real event and its mail. The test reads the registry of the application
// (helpers/metrics.ts), as its scrape would.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { newOrderId, newRecipient, orderPaid } from '../helpers/events';
import { waitForMails } from '../helpers/mailbox';
import { scrape, total, type MetricSample } from '../helpers/metrics';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let app: WorkerApp;
let broker: TestBroker;

beforeAll(async () => {
  app = await createWorkerApp(); // first: it declares the queue the test publishes to
  broker = await connectTestBroker();
});
afterAll(async () => {
  try {
    await app.close();
  } finally {
    await broker.close();
  }
});

/** Until the dispatcher has counted a try that ended this way: it counts after the send. */
const dispatched = (outcome: string): Promise<MetricSample[]> =>
  waitFor(
    () => scrape(app),
    (samples) => total(samples, 'notifications_dispatched_total', { outcome }) > 0,
    { what: `a notification counted as ${outcome}` },
  );

describe('the metrics of notifications (MET-052)', () => {
  it('observes the delivery of the event, and counts its mail as sent', async () => {
    const order = { orderId: newOrderId(), recipient: newRecipient() };

    await broker.publish(orderPaid(order));
    await waitForMails(order.recipient.email);
    const samples = await dispatched('sent');

    expect(total(samples, 'notifications_dispatched_total', { outcome: 'sent' })).toBe(1);
    expect(
      total(samples, 'broker_message_duration_seconds_count', {
        queue: 'notifications.order-events',
        outcome: 'ok',
        process: 'worker',
      }),
    ).toBe(1);
  });

  it('counts a mail the server refuses for good as given up', async () => {
    // the mail server of the run takes one domain only: any other is refused for good
    const order = { orderId: newOrderId(), recipient: newRecipient('elsewhere.test') };

    await broker.publish(orderPaid(order));
    const samples = await dispatched('given_up');

    expect(total(samples, 'notifications_dispatched_total', { outcome: 'given_up' })).toBe(1);
  });

  it('reports its connection pool, and carries no id and no address on any label', async () => {
    const samples = await scrape(app);
    const values = samples.flatMap((sample) => Object.values(sample.labels));

    expect(
      total(samples, 'db_pool_connections', { pool: 'primary', state: 'total' }),
    ).toBeGreaterThan(0);
    expect(values.filter((value) => UUID.test(value) || value.includes('@'))).toEqual([]);
  });
});
