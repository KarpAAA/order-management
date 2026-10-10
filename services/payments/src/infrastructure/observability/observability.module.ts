import { Global, Module } from '@nestjs/common';

import { metricsConfig, type MetricsConfig } from '@config/configuration';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { METRICS } from '@shared/observability/metrics';

import { MetricsServer } from './metrics-server';
import { METRICS_PORT } from './observability.tokens';
import { PromMetrics } from './prom.metrics';

/**
 * The metrics of the process (docs/adr/0027): `METRICS` for whoever counts, and the server
 * Prometheus reads them from. Nothing else may keep a number: no second registry, no
 * `prom-client` outside this folder. A copy of the module of the api, for a service of one
 * process.
 */
@Global()
@Module({
  providers: [
    {
      provide: METRICS_PORT,
      inject: [metricsConfig.KEY],
      useFactory: (config: MetricsConfig): number => config.port,
    },
    {
      provide: PromMetrics,
      inject: [metricsConfig.KEY, LOGGER],
      useFactory: (config: MetricsConfig, logger: Logger) => {
        const log = logger.child({ context: PromMetrics.name });
        return new PromMetrics({
          // the only process of the service; the label is there so that a query reads the
          // same for every service
          process: 'worker',
          buckets: config.durationBuckets,
          // a process that serves no metrics does not watch its runtime either
          runtime: config.port !== 0,
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
