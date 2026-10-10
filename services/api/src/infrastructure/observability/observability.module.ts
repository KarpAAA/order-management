import { Global, Module } from '@nestjs/common';

import { metricsConfig, type MetricsConfig } from '@config/configuration';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { METRICS } from '@shared/observability/metrics';

import { PROCESS_NAME } from '../logger/logger.module';

import { MetricsServer } from './metrics-server';
import { METRICS_PORT } from './observability.tokens';
import { PromMetrics } from './prom.metrics';

/**
 * Where a process serves its metrics when `METRICS_PORT` is not set: under `pnpm dev` the
 * processes of every service share one host, so each has a port of its own. A container
 * names its port (docs/adr/0027).
 */
const DEFAULT_PORTS: Record<string, number> = { api: 9464, worker: 9465 };

/**
 * The metrics of the process (docs/adr/0027): `METRICS` for whoever counts, and the server
 * Prometheus reads them from. Nothing else may keep a number: no second registry, no
 * `prom-client` outside this folder.
 */
@Global()
@Module({
  providers: [
    {
      provide: METRICS_PORT,
      inject: [metricsConfig.KEY, { token: PROCESS_NAME, optional: true }],
      useFactory: (config: MetricsConfig, process?: string): number =>
        config.port ?? DEFAULT_PORTS[process ?? ''] ?? 0,
    },
    {
      provide: PromMetrics,
      inject: [metricsConfig.KEY, METRICS_PORT, LOGGER, { token: PROCESS_NAME, optional: true }],
      useFactory: (config: MetricsConfig, port: number, logger: Logger, process?: string) => {
        const log = logger.child({ context: PromMetrics.name });
        return new PromMetrics({
          ...(process === undefined ? {} : { process }),
          buckets: config.durationBuckets,
          // a process that serves no metrics does not watch its runtime either
          runtime: port !== 0,
          onCollectError: (metric, err) => {
            log.warn({ metric, err }, 'metric not collected');
          },
        });
      },
    },
    { provide: METRICS, useExisting: PromMetrics },
    MetricsServer,
  ],
  exports: [METRICS, PromMetrics],
})
export class ObservabilityModule {}
