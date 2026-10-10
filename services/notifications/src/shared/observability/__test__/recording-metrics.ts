import type {
  Counter,
  Gauge,
  GaugeSpec,
  Histogram,
  LabelValues,
  Metrics,
  MetricSpec,
  Sample,
} from '../metrics';

export interface RecordedSample {
  name: string;
  labels: Record<string, string | number>;
  value: number;
}

/**
 * Metrics that keep what they are given, for a test: every `inc`, `set` and `observe` is a
 * sample, oldest first. A label the spec did not declare throws, as the real store does.
 */
export class RecordingMetrics implements Metrics {
  readonly samples: RecordedSample[] = [];
  private readonly collectors = new Map<string, (() => Promise<readonly Sample<string>[]>)[]>();

  counter<L extends string = never>(spec: MetricSpec<L>): Counter<L> {
    return {
      inc: (labels, by = 1) => {
        this.record(spec, labels, by);
      },
    };
  }

  gauge<L extends string = never>(spec: GaugeSpec<L>): Gauge<L> {
    if (spec.collect) {
      this.collectors.set(spec.name, [...(this.collectors.get(spec.name) ?? []), spec.collect]);
    }
    return {
      set: (labels, value) => {
        this.record(spec, labels, value);
      },
    };
  }

  histogram<L extends string = never>(spec: MetricSpec<L>): Histogram<L> {
    return {
      observe: (labels, seconds) => {
        this.record(spec, labels, seconds);
      },
    };
  }

  /** The samples of one metric. */
  of(name: string): RecordedSample[] {
    return this.samples.filter((sample) => sample.name === name);
  }

  /** What was counted under these labels: the sum of the samples that carry them. */
  total(name: string, labels: Record<string, string | number> = {}): number {
    return this.of(name)
      .filter((sample) =>
        Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
      )
      .reduce((sum, sample) => sum + sample.value, 0);
  }

  /** What a gauge with `collect` would show now. */
  async collected(name: string): Promise<readonly Sample<string>[]> {
    const collectors = this.collectors.get(name);
    if (!collectors) throw new Error(`no gauge ${name} with collect()`);
    return (await Promise.all(collectors.map((collect) => collect()))).flat();
  }

  private record<L extends string>(
    spec: MetricSpec<L>,
    labels: LabelValues<L>,
    value: number,
  ): void {
    const declared: readonly string[] = spec.labels ?? [];
    const unknown = Object.keys(labels).filter((label) => !declared.includes(label));
    if (unknown.length > 0) {
      throw new Error(`${spec.name}: label ${unknown.join(', ')} is not declared`);
    }
    this.samples.push({ name: spec.name, labels: { ...labels }, value });
  }
}
