import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { databaseConfig, type DatabaseConfig } from '@config/configuration';

import { PrismaClient } from './generated/prisma/client';

import type { Prisma } from './generated/prisma/client';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/**
 * The single PrismaClient of the process, WITHOUT tenant scoping. Modules never inject it
 * for tenant data: they get the scoped handles from `database.tokens.ts`. The only consumers
 * are the scoped client factory and identity's documented cross-tenant reads.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(databaseConfig.KEY) config: DatabaseConfig) {
    super({
      adapter: new PrismaPg({ connectionString: config.url }),
      log: config.logQueries
        ? ['warn', 'error', { emit: 'event', level: 'query' }]
        : ['warn', 'error'],
    });
    // Subscribed here, not in onModuleInit: the tenant-scoped client ($extends) inherits this
    // class's methods, so Nest runs onModuleInit on it too — and extended clients have no $on.
    if (config.logQueries) {
      const logger = new Logger('Prisma');
      this.onQuery((e) => {
        logger.debug(`${String(e.duration)} ms ${e.query}`);
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Subscribes to every SQL statement. Only fires with DATABASE_LOG_QUERIES=true; used for the
   * debug log and by the e2e N+1 guard (test/helpers/queries.ts).
   */
  onQuery(listener: (event: Prisma.QueryEvent) => void): void {
    // the class is declared without log generics, so `query` is not in its $on signature
    (this as unknown as PrismaClient<'query'>).$on('query', listener);
  }
}
