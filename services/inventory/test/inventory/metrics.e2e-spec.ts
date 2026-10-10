// The metrics of the service (MET-051, docs/adr/0027): what Prometheus would read after a
// real command. The test reads the registry of the application (helpers/metrics.ts), as its
// scrape would.
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { adjustCommand, COMMANDS_QUEUE } from '../helpers/commands';
import { scrape, total, type MetricSample } from '../helpers/metrics';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let broker: TestBroker;
let service: WorkerApp;
let samples: MetricSample[];

beforeAll(async () => {
  // first: its queue must be bound before the service publishes anything
  broker = await connectTestBroker();
  service = await createWorkerApp();

  const productId = uuidv7();
  await broker.send(adjustCommand({ productId, delta: 5 }));
  // the answer is out: the command was handled and the relay has published
  await broker.waitForEvents(productId);
  // the relay counts a pass when it has ended, a moment after its event is out
  samples = await waitFor(
    () => scrape(service),
    (now) => total(now, 'outbox_published_total') > 0,
    { what: 'the relay to count what it published' },
  );
});
afterAll(async () => {
  try {
    await service.close();
  } finally {
    await broker.close();
  }
});

describe('the metrics of inventory after a command (MET-051)', () => {
  it('observes the delivery by its queue, in the one process of the service', () => {
    expect(
      total(samples, 'broker_message_duration_seconds_count', {
        queue: COMMANDS_QUEUE,
        outcome: 'ok',
        process: 'worker',
      }),
    ).toBe(1);
  });

  it('reports what the relay published and what still waits', () => {
    expect(total(samples, 'outbox_published_total')).toBeGreaterThan(0);
    expect(samples.find((sample) => sample.name === 'outbox_pending')?.value).toBe(0);
  });

  it('reports its connection pool', () => {
    expect(
      total(samples, 'db_pool_connections', { pool: 'primary', state: 'total' }),
    ).toBeGreaterThan(0);
  });

  it('carries no id on any label', () => {
    expect(
      samples.filter((sample) => Object.values(sample.labels).some((value) => UUID.test(value))),
    ).toEqual([]);
  });
});
