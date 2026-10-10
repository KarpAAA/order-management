import type { Metrics } from './metrics';

const nothing = { inc: () => undefined, set: () => undefined, observe: () => undefined };

/** Metrics that count nothing: for a class built by hand that has to be given some. */
export const silentMetrics: Metrics = {
  counter: () => nothing,
  gauge: () => nothing,
  histogram: () => nothing,
};
