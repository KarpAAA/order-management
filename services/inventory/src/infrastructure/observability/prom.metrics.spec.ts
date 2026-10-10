import { context, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { portOf, serveMetrics } from './metrics-server';
import { PromMetrics, type PromMetricsOptions } from './prom.metrics';

const BUCKETS = [0.1, 1];

const metricsWith = (options: Partial<PromMetricsOptions> = {}) =>
  new PromMetrics({ buckets: BUCKETS, runtime: false, ...options });

/** The lines of one metric family, as Prometheus reads them. */
const lines = async (metrics: PromMetrics, name: string): Promise<string[]> =>
  (await metrics.expose()).body.split('\n').filter((line) => line.startsWith(name));

describe('PromMetrics: the metrics of a process (docs/adr/0027)', () => {
  it('MET-001 counts under the labels it is given, and names the process on every series', async () => {
    const metrics = metricsWith({ process: 'worker' });
    const parked = metrics.counter({ name: 'parked_total', help: 'h', labels: ['queue'] });

    parked.inc({ queue: 'api.payment-events' });
    parked.inc({ queue: 'api.payment-events' }, 2);

    expect(await lines(metrics, 'parked_total')).toEqual([
      'parked_total{queue="api.payment-events",process="worker"} 3',
    ]);
  });

  it('MET-001 answers with the same metric when it is asked for a name twice', async () => {
    const metrics = metricsWith();
    const spec = { name: 'placed_total', help: 'h' };

    metrics.counter(spec).inc({});
    metrics.counter(spec).inc({});

    expect(await lines(metrics, 'placed_total')).toEqual(['placed_total 2']);
  });

  it('MET-001 refuses a label the metric did not declare', () => {
    const counter = metricsWith().counter({ name: 'placed_total', help: 'h' });

    expect(() => {
      counter.inc({ workspace_id: 'w-1' });
    }).toThrow();
  });

  it('MET-002 keeps a duration in the buckets of the configuration, or in its own', async () => {
    const metrics = metricsWith();
    metrics.histogram({ name: 'a_seconds', help: 'h' }).observe({}, 0.5);
    metrics.histogram({ name: 'b_seconds', help: 'h', buckets: [2] }).observe({}, 0.5);

    expect(await lines(metrics, 'a_seconds_bucket')).toEqual([
      'a_seconds_bucket{le="0.1"} 0',
      'a_seconds_bucket{le="1"} 1',
      'a_seconds_bucket{le="+Inf"} 1',
    ]);
    expect(await lines(metrics, 'b_seconds_bucket')).toEqual([
      'b_seconds_bucket{le="2"} 1',
      'b_seconds_bucket{le="+Inf"} 1',
    ]);
  });

  it('MET-003 asks a collected gauge when the metrics are read, every collector of it', async () => {
    const metrics = metricsWith();
    let waiting = 1;
    const gauge = { name: 'pool_connections', help: 'h', labels: ['pool'] as const };
    metrics.gauge({
      ...gauge,
      collect: () => Promise.resolve([{ labels: { pool: 'primary' }, value: waiting }]),
    });
    metrics.gauge({
      ...gauge,
      collect: () => Promise.resolve([{ labels: { pool: 'replica' }, value: 7 }]),
    });

    expect(await lines(metrics, 'pool_connections')).toEqual([
      'pool_connections{pool="primary"} 1',
      'pool_connections{pool="replica"} 7',
    ]);
    waiting = 4;
    expect(await lines(metrics, 'pool_connections')).toContain(
      'pool_connections{pool="primary"} 4',
    );
  });

  it('MET-003 shows no value for a gauge that could not be collected, and says so', async () => {
    const failed: unknown[] = [];
    const metrics = metricsWith({ onCollectError: (name, err) => failed.push([name, err]) });
    const down = new Error('redis is away');
    metrics.gauge({ name: 'outbox_pending', help: 'h', collect: () => Promise.reject(down) });
    metrics.gauge({
      name: 'queue_jobs',
      help: 'h',
      labels: ['queue'],
      collect: () => Promise.reject(down),
    });
    metrics.counter({ name: 'placed_total', help: 'h' }).inc({});

    // the read itself goes through, with everything else
    // never 0: that would say "nothing waits"
    expect(await lines(metrics, 'outbox_pending')).toEqual(['outbox_pending Nan']);
    expect(await lines(metrics, 'queue_jobs')).toEqual([]);
    expect(await lines(metrics, 'placed_total')).toEqual(['placed_total 1']);
    // once per read of the metrics
    expect(failed.slice(0, 2)).toEqual([
      ['outbox_pending', down],
      ['queue_jobs', down],
    ]);
  });

  it('collects the metrics of the runtime only when asked to', async () => {
    expect(await lines(metricsWith(), 'nodejs_eventloop_lag_seconds')).toEqual([]);
    expect(await lines(metricsWith({ runtime: true }), 'nodejs_eventloop_lag_seconds')).not.toEqual(
      [],
    );
  });

  describe('exemplars', () => {
    const TRACE = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' };
    const inSpan = (traceFlags: TraceFlags, work: () => void) => {
      const span = trace.wrapSpanContext({ ...TRACE, traceFlags });
      context.with(trace.setSpan(context.active(), span), work);
    };

    beforeAll(() => {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    });
    afterAll(() => {
      context.disable();
    });

    it('MET-004 keeps the trace of an observation made inside a recorded trace', async () => {
      const metrics = metricsWith();
      const duration = metrics.histogram({ name: 'http_seconds', help: 'h' });

      inSpan(TraceFlags.SAMPLED, () => {
        duration.observe({}, 0.5);
      });

      const [bucket] = (await lines(metrics, 'http_seconds_bucket{le="1"}')) as [string];
      expect(bucket).toContain(`# {trace_id="${TRACE.traceId}",span_id="${TRACE.spanId}"} 0.5`);
    });

    it('MET-004 keeps none outside a trace, or inside one that is not recorded', async () => {
      const metrics = metricsWith();
      const duration = metrics.histogram({ name: 'http_seconds', help: 'h' });

      duration.observe({}, 0.5);
      inSpan(TraceFlags.NONE, () => {
        duration.observe({}, 0.5);
      });

      expect(await lines(metrics, 'http_seconds_bucket{le="1"}')).toEqual([
        'http_seconds_bucket{le="1"} 2',
      ]);
    });
  });
});

describe('the metrics endpoint (docs/adr/0027)', () => {
  it('MET-005 serves GET /metrics as OpenMetrics, and nothing else', async () => {
    const metrics = metricsWith();
    metrics.counter({ name: 'placed_total', help: 'h' }).inc({});
    const server = await serveMetrics(metrics, 0);
    const url = `http://localhost:${String(portOf(server))}`;
    try {
      const scraped = await fetch(`${url}/metrics`);
      expect(scraped.status).toBe(200);
      expect(scraped.headers.get('content-type')).toContain('application/openmetrics-text');
      expect(await scraped.text()).toContain('placed_total 1');

      expect((await fetch(`${url}/`)).status).toBe(404);
      expect((await fetch(`${url}/metrics`, { method: 'POST' })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
