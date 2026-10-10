// The metrics of the api and of the worker (MET-030…037, docs/adr/0027): what Prometheus
// would read after real requests and real messages. A test reads the registry of an app
// (helpers/metrics.ts), as its scrape would. The other services are not here: the test is the
// other side of the broker.
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import {
  connectTestBroker,
  paymentFailed,
  paymentSucceeded,
  type TestBroker,
} from '../helpers/broker';
import { scrape, total, type MetricSample } from '../helpers/metrics';
import { orderPath } from '../helpers/paths';
import { waitFor, waitForStatus } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { USER_ACME_MEMBER, WS_ACME } from '../seed/ids';

const PLACE = '/v1/workspaces/:workspaceId/orders/:orderId/place';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let api: ApiApp;
let worker: WorkerApp;
let broker: TestBroker;

beforeAll(async () => {
  // first: its queues must be bound before the api publishes anything
  broker = await connectTestBroker();
  api = await createApiApp();
  worker = await createWorkerApp();
});
afterAll(async () => {
  try {
    await worker.close();
  } finally {
    await api.close();
    await broker.close();
  }
});

const member = asUser(USER_ACME_MEMBER);

/** Places a new order and answers as payments, once the charge was asked for. */
async function placed(answer: 'paid' | { declined: string }): Promise<string> {
  const orderId = (await orderFactory.create()).id;
  const attempt = { workspaceId: WS_ACME, orderId, paymentAttempt: 1 };
  await api
    .http()
    .post(`${orderPath(WS_ACME, orderId)}/place`)
    .set(member)
    .send({ version: 0 })
    .expect(202);
  await broker.waitForCommands(orderId);
  await broker.publish(
    answer === 'paid' ? paymentSucceeded(attempt, 'ch_1') : paymentFailed(attempt, answer.declined),
  );
  const status = answer === 'paid' ? 'PAID' : 'PAYMENT_FAILED';
  await waitForStatus(api, orderPath(WS_ACME, orderId), member, [status]);
  return orderId;
}

/** Until the metrics of the app show what is waited for: a count is made after the commit. */
const scraped = (
  app: ApiApp | WorkerApp,
  until: (samples: MetricSample[]) => boolean,
  what: string,
) => waitFor(() => scrape(app), until, { what });

describe('the metrics of a placed order', () => {
  let before: { api: MetricSample[]; worker: MetricSample[] };

  beforeAll(async () => {
    before = { api: await scrape(api), worker: await scrape(worker) };
    await placed('paid');
  });

  it('MET-030 the api observes the request under the pattern of its route', async () => {
    const samples = await scrape(api);
    const labels = { method: 'POST', route: PLACE, status: '202', process: 'api' };

    expect(total(samples, 'http_request_duration_seconds_count', labels)).toBe(
      total(before.api, 'http_request_duration_seconds_count', labels) + 1,
    );
    // one histogram is rate, errors and duration: the buckets are there for the percentile
    expect(total(samples, 'http_request_duration_seconds_bucket', { ...labels, le: '+Inf' })).toBe(
      total(samples, 'http_request_duration_seconds_count', labels),
    );
  });

  it('MET-031 the order is counted as placed where it was placed, and as paid where it was paid', async () => {
    const inWorker = await scraped(
      worker,
      (samples) => total(samples, 'orders_paid_total') > total(before.worker, 'orders_paid_total'),
      'orders_paid_total of the worker to go up',
    );
    const inApi = await scrape(api);

    expect(total(inApi, 'orders_placed_total')).toBe(total(before.api, 'orders_placed_total') + 1);
    expect(total(inWorker, 'orders_paid_total')).toBe(
      total(before.worker, 'orders_paid_total') + 1,
    );
    // the api paid nothing: each process counts what it did, and the store adds them up
    expect(total(inApi, 'orders_paid_total')).toBe(0);
  });

  it('MET-032 the use cases are observed by name and outcome, in the process that ran them', async () => {
    const outcome = { outcome: 'ok' };

    expect(
      total(await scrape(api), 'use_case_duration_seconds_count', {
        use_case: 'PlaceOrderService',
        process: 'api',
        ...outcome,
      }),
    ).toBeGreaterThan(0);
    expect(
      total(await scrape(worker), 'use_case_duration_seconds_count', {
        use_case: 'CompleteOrderPaymentService',
        process: 'worker',
        ...outcome,
      }),
    ).toBeGreaterThan(0);
  });

  it('MET-033 the worker observes every delivery by its queue, and what the relay published', async () => {
    const samples = await scrape(worker);
    const delivered = (queue: string) =>
      total(samples, 'broker_message_duration_seconds_count', { queue, outcome: 'ok' });

    expect(delivered('api.inventory-events')).toBeGreaterThan(0);
    expect(delivered('api.payment-events')).toBeGreaterThan(0);
    expect(total(samples, 'outbox_published_total')).toBeGreaterThan(
      total(before.worker, 'outbox_published_total'),
    );
  });
});

describe('the cause of a failed payment (MET-034)', () => {
  it.each([
    ['the provider never answered', 'psp_unavailable', 'provider_unavailable'],
    ['the provider refused the card', 'card_declined', 'declined'],
  ])('when %s', async (_case, declined, cause) => {
    const count = (samples: MetricSample[]) =>
      total(samples, 'orders_payment_failed_total', { cause });
    const before = count(await scrape(worker));

    await placed({ declined });

    const samples = await scraped(worker, (now) => count(now) > before, `a failure by ${cause}`);
    expect(count(samples)).toBe(before + 1);
    // the reason of the provider is on no series
    expect(samples.filter((sample) => Object.values(sample.labels).includes(declined))).toEqual([]);
  });
});

describe('what is measured once for the service (MET-035)', () => {
  it('the worker reports the backlog of the outbox and the depth of every queue', async () => {
    const samples = await scrape(worker);
    const queues = new Set(
      samples.filter((sample) => sample.name === 'queue_jobs').map((sample) => sample.labels.queue),
    );

    expect(
      samples.find((sample) => sample.name === 'outbox_pending')?.value,
    ).toBeGreaterThanOrEqual(0);
    expect(
      samples.find((sample) => sample.name === 'outbox_oldest_age_seconds')?.value,
    ).toBeGreaterThanOrEqual(0);
    expect(queues).toEqual(new Set(['orders', 'outbox', 'inbox', 'idempotency']));
    expect(total(samples, 'queue_jobs', { queue: 'orders', state: 'failed' })).toBe(0);
  });

  it('the api reports neither: the same number from two processes would be added up', async () => {
    const names = new Set((await scrape(api)).map((sample) => sample.name));

    expect(names.has('queue_jobs')).toBe(false);
    expect(names.has('outbox_pending')).toBe(false);
  });

  it('every process reports its own connection pool', async () => {
    for (const [process, app] of [
      ['api', api],
      ['worker', worker],
    ] as const) {
      const samples = await scrape(app);
      const pool = (state: string) =>
        total(samples, 'db_pool_connections', { pool: 'primary', state, process });
      expect(pool('total'), process).toBeGreaterThan(0);
      expect(pool('waiting'), process).toBe(0);
    }
  });
});

describe('a message the worker gives up (MET-036)', () => {
  it('is counted as parked, under its queue', async () => {
    const parked = (samples: MetricSample[]) =>
      total(samples, 'broker_messages_parked_total', { queue: 'api.payment-events' });
    const before = parked(await scrape(worker));

    broker.publishRaw('payments.payment-succeeded', Buffer.from('not a contract'));

    const samples = await scraped(worker, (now) => parked(now) > before, 'a parked message');
    expect(parked(samples)).toBe(before + 1);
    expect(
      total(samples, 'broker_message_duration_seconds_count', {
        queue: 'api.payment-events',
        outcome: 'failed',
      }),
    ).toBeGreaterThan(0);
  });
});

describe('the cardinality of the metrics (MET-037)', () => {
  beforeAll(async () => {
    // requests whose URL carries ids, matched and not
    await api.http().get(orderPath(WS_ACME, uuidv7())).set(member).expect(404);
    await api.http().get(`/v1/nothing/${uuidv7()}`).set(member).expect(404);
    await api.http().get(`/${uuidv7()}`).expect(404);
  });

  it.each([
    ['api', () => api],
    ['worker', () => worker],
  ])('no label of the %s carries an id, of a tenant or of anything', async (_process, app) => {
    const samples = await scrape(app());
    const withId = samples.filter((sample) =>
      Object.values(sample.labels).some((value) => UUID.test(value)),
    );
    const names = new Set(samples.flatMap((sample) => Object.keys(sample.labels)));

    expect(withId).toEqual([]);
    for (const label of ['workspace_id', 'workspaceId', 'order_id', 'user_id', 'actor', 'email']) {
      expect(names.has(label), label).toBe(false);
    }
  });

  it('a request no route matched is one series, whatever was asked for', async () => {
    const routes = new Set(
      (await scrape(api))
        .filter((sample) => sample.name === 'http_request_duration_seconds_count')
        .map((sample) => sample.labels.route),
    );

    expect(routes.has('unmatched')).toBe(true);
    // every other route is one the app registered
    const registered = new Set(api.routes().map((route) => route.split(' ')[1]));
    expect([...routes].filter((route) => route !== 'unmatched' && !registered.has(route))).toEqual(
      [],
    );
  });

  it('the metrics are not on the port of the API', async () => {
    await api.http().get('/metrics').expect(404);
  });
});
