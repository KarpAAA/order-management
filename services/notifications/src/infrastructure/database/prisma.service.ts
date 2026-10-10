import { Inject, Injectable, Optional } from '@nestjs/common';

import { databaseConfig, type DatabaseConfig } from '@config/configuration';
import { METRICS, type Metrics } from '@shared/observability/metrics';
import { silentMetrics } from '@shared/observability/silent-metrics';

import { PrismaClient } from './generated/prisma/client';
import { MeasuredPrismaPg, measurePool } from './pool.metrics';

import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** The single PrismaClient of the process, connected as the application role. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(databaseConfig.KEY) config: DatabaseConfig,
    // left out by a test that builds the client by hand
    @Optional() @Inject(METRICS) metrics: Metrics = silentMetrics,
  ) {
    super({
      adapter: new MeasuredPrismaPg(
        { connectionString: config.url, max: config.poolMax },
        measurePool(metrics, 'primary'),
      ),
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
