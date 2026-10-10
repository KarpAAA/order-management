/**
 * The numbers of the service over time (ops/observability.md §1, docs/adr/0027): how many,
 * how fast, how often. Written by the entries and the infrastructure, never by a use case.
 *
 * A label is a dimension of the store, not a field of a line: every value of it is a time
 * series of its own, for every other label it meets. So a label takes values from a closed
 * set (a route pattern, a status, a queue, an outcome) and never an id of anything.
 */
export type LabelValues<L extends string> = Readonly<Record<L, string | number>>;

export interface MetricSpec<L extends string> {
  /** `<what>_<unit>` or `<noun>_<verb>_total`, in snake case. */
  name: string;
  help: string;
  labels?: readonly L[];
}

export interface HistogramSpec<L extends string> extends MetricSpec<L> {
  /** Upper bounds in seconds; left out: the buckets of the configuration. */
  buckets?: readonly number[];
}

export interface Sample<L extends string> {
  labels: LabelValues<L>;
  value: number;
}

export interface GaugeSpec<L extends string> extends MetricSpec<L> {
  /**
   * Asked every time the metrics are read, instead of a timer: what it resolves with is the
   * whole gauge. A failure leaves the gauge without a value for that read, never with 0.
   */
  collect?: () => Promise<readonly Sample<L>[]>;
}

/** Only goes up: its rate is what is looked at. */
export interface Counter<L extends string> {
  inc(labels: LabelValues<L>, by?: number): void;
}

/** A value of now. */
export interface Gauge<L extends string> {
  set(labels: LabelValues<L>, value: number): void;
}

/** Counts per bucket, so a percentile can be computed over every instance together. */
export interface Histogram<L extends string> {
  observe(labels: LabelValues<L>, seconds: number): void;
}

/** Asked twice for the same name, a factory answers with the same metric. */
export interface Metrics {
  counter<L extends string = never>(spec: MetricSpec<L>): Counter<L>;
  gauge<L extends string = never>(spec: GaugeSpec<L>): Gauge<L>;
  histogram<L extends string = never>(spec: HistogramSpec<L>): Histogram<L>;
}

export const METRICS = Symbol('METRICS');

/** Seconds since `startedAt`, a reading of `performance.now()`. */
export const secondsSince = (startedAt: number): number => (performance.now() - startedAt) / 1000;
