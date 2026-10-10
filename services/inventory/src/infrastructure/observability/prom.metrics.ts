import { trace, TraceFlags } from '@opentelemetry/api';
import {
  collectDefaultMetrics,
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
  Registry,
  type OpenMetricsContentType,
} from 'prom-client';

import type {
  Counter,
  Gauge,
  GaugeSpec,
  Histogram,
  HistogramSpec,
  Metrics,
  MetricSpec,
  Sample,
} from '@shared/observability/metrics';

export interface PromMetricsOptions {
  /** Which process of the service this is: a label of every metric (ops/observability.md §1). */
  process?: string;
  /** The buckets of a histogram that names none, in seconds. */
  buckets: readonly number[];
  /** The metrics of the runtime too: event loop lag, heap, GC. */
  runtime: boolean;
  /** Told when a gauge could not be collected: that read shows no value for it. */
  onCollectError?: (name: string, err: unknown) => void;
}

/**
 * The metrics of the process, kept by `prom-client` and read by Prometheus from `/metrics`
 * (docs/adr/0027).
 *
 * A registry of its own, not the global one of the library: the e2e suite runs several
 * applications in one process, and each counts for itself.
 *
 * The registry speaks OpenMetrics, the format that can carry an exemplar: an observation of
 * a histogram made inside a trace keeps the id of that trace beside its bucket, which is the
 * way from a point of a graph to one request. Nobody passes it: it is read from the active
 * span, as the logger reads it for a line.
 */
export class PromMetrics implements Metrics {
  private readonly registry = new Registry<OpenMetricsContentType>();
  private readonly made = new Map<string, unknown>();
  /** By gauge: a gauge may be collected from several places (a pool each), all of them asked. */
  private readonly collectors = new Map<string, (() => Promise<readonly Sample<string>[]>)[]>();

  constructor(private readonly options: PromMetricsOptions) {
    this.registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    if (options.process !== undefined) this.registry.setDefaultLabels({ process: options.process });
    if (options.runtime) collectDefaultMetrics({ register: this.registry });
  }

  counter<L extends string = never>(spec: MetricSpec<L>): Counter<L> {
    return this.once(spec.name, () => {
      const counter = new PromCounter({ ...this.common(spec) });
      return {
        inc: (labels, by = 1) => {
          counter.inc(labels, by);
        },
      };
    });
  }

  gauge<L extends string = never>(spec: GaugeSpec<L>): Gauge<L> {
    const { name, collect } = spec;
    if (collect !== undefined) {
      this.collectors.set(name, [...(this.collectors.get(name) ?? []), collect]);
    }
    return this.once(name, () => {
      const collectors = () => this.collectors.get(name) ?? [];
      const onError = this.options.onCollectError;
      const unlabelled = (spec.labels ?? []).length === 0;
      const gauge = new PromGauge({
        ...this.common(spec),
        async collect() {
          if (collectors().length === 0) return;
          this.reset();
          for (const collect of collectors()) {
            try {
              for (const { labels, value } of await collect()) {
                this.set(labels as never, value);
              }
            } catch (err: unknown) {
              // a gauge without labels cannot be left out, and 0 would be an answer: not a number
              if (unlabelled) this.set(Number.NaN);
              onError?.(name, err);
            }
          }
        },
      });
      return {
        set: (labels, value) => {
          gauge.set(labels, value);
        },
      };
    });
  }

  histogram<L extends string = never>(spec: HistogramSpec<L>): Histogram<L> {
    return this.once(spec.name, () => {
      const histogram = new PromHistogram({
        ...this.common(spec),
        buckets: [...(spec.buckets ?? this.options.buckets)],
        enableExemplars: true,
      });
      return {
        observe: (labels, seconds) => {
          const exemplarLabels = activeTrace();
          histogram.observe({
            labels,
            value: seconds,
            // typed by the library as the labels of the metric; they are labels of their own
            ...(exemplarLabels === undefined ? {} : { exemplarLabels: exemplarLabels as never }),
          });
        },
      };
    });
  }

  /** What Prometheus reads, and the content type it is served with. */
  async expose(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  private common<L extends string>(spec: MetricSpec<L>) {
    return {
      name: spec.name,
      help: spec.help,
      labelNames: [...(spec.labels ?? [])],
      registers: [this.registry],
    };
  }

  private once<T>(name: string, make: () => T): T {
    const known = this.made.get(name);
    if (known !== undefined) return known as T;
    const metric = make();
    this.made.set(name, metric);
    return metric;
  }
}

/** The trace an observation belongs to, when it is recorded: an exemplar nobody keeps is noise. */
function activeTrace(): { trace_id: string; span_id: string } | undefined {
  const span = trace.getActiveSpan()?.spanContext();
  if (!span || (span.traceFlags & TraceFlags.SAMPLED) === 0) return undefined;
  return { trace_id: span.traceId, span_id: span.spanId };
}
