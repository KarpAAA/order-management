import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { databaseConfig, type DatabaseConfig } from '@config/configuration';

import { PrismaClient } from './generated/prisma/client';

import type { Prisma } from './generated/prisma/client';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/**
 * The single PrismaClient of the process, WITHOUT tenant scoping. Modules never inject it
 * for tenant data: they get the scoped handles from `database.tokens.ts`. The only consumers
 * are the scoped client factory, identity's documented cross-tenant reads (`asUser`) and the
 * partition adapter of orders. Row-Level Security still applies to it: a tenant table read
 * through this client with no context returns nothing.
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
   * Runs one query as `userId`: `app.user_id` is set for the transaction of that query, and the
   * `own_memberships` policy lets the user's memberships through, in any workspace. For the
   * reads that are cross-tenant by nature; the query is built on this client and not awaited.
   */
  async asUser<T>(userId: string, query: Prisma.PrismaPromise<T>): Promise<T> {
    const [, result] = await this.$transaction([
      this.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`,
      query,
    ]);
    return result;
  }

  /**
   * Subscribes to every SQL statement. Only fires with DATABASE_LOG_QUERIES=true; used for the
   * debug log and by the e2e N+1 guard (`countQueries` in test/helpers/api-app.ts).
   */
  onQuery(listener: (event: Prisma.QueryEvent) => void): void {
    // the class is declared without log generics, so `query` is not in its $on signature
    (this as unknown as PrismaClient<'query'>).$on('query', listener);
  }
}
