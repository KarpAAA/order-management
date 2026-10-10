// What Prometheus reads from an app of the test, taken apart: the text of `/metrics`
// (OpenMetrics) as samples. A test reads the registry of the app, not a port: several
// applications share the process (METRICS_PORT=0 in .env.test).
import { PromMetrics } from '@infra/observability/prom.metrics';

import type { Type } from '@nestjs/common';

export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*?)\})? (\S+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** Every sample of the text; the exemplar after a `#` is left out. */
export function parseMetrics(text: string): MetricSample[] {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [, name, labels = '', value] = SAMPLE.exec(line) ?? [];
      if (name === undefined) throw new Error(`not a sample: ${line}`);
      return {
        name,
        labels: Object.fromEntries([...labels.matchAll(LABEL)].map(([, key, v]) => [key, v])),
        value: Number(value),
      };
    });
}

/** The metrics of an app of the test, as its scrape would see them now. */
export async function scrape(app: { get<T>(token: Type<T>): T }): Promise<MetricSample[]> {
  return parseMetrics((await app.get(PromMetrics).expose()).body);
}

/** The sum of the samples of `name` that carry `labels`; 0 when there is none. */
export function total(
  samples: MetricSample[],
  name: string,
  labels: Record<string, string> = {},
): number {
  return samples
    .filter(
      (sample) =>
        sample.name === name &&
        Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
    )
    .reduce((sum, sample) => sum + sample.value, 0);
}
