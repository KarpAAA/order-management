import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { databaseConfig, type DatabaseConfig } from '@config/configuration';

import { PrismaClient } from './generated/prisma/client';
import { PrismaService } from './prisma.service';

import type { OnModuleDestroy } from '@nestjs/common';

/**
 * The client of the read replica, WITHOUT tenant scoping (docs/adr/0009-read-replica-routing.md).
 * With no `DATABASE_REPLICA_URL` there is no replica: `client` is the primary and nothing is
 * routed. Nothing connects at boot: a replica that is down must not stop the process.
 */
@Injectable()
export class ReplicaPrismaService implements OnModuleDestroy {
  readonly enabled: boolean;
  readonly client: PrismaClient;

  constructor(@Inject(databaseConfig.KEY) config: DatabaseConfig, primary: PrismaService) {
    this.enabled = config.replicaUrl !== undefined;
    this.client = config.replicaUrl ? createReplicaClient(config.replicaUrl, config) : primary;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) await this.client.$disconnect();
  }
}

function createReplicaClient(url: string, config: DatabaseConfig): PrismaClient {
  // the same adapter options as the primary: the replica is reached through PgBouncer too
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: config.poolMax }),
    log: config.logQueries
      ? ['warn', 'error', { emit: 'event', level: 'query' }]
      : ['warn', 'error'],
  });
  if (config.logQueries) {
    const logger = new Logger('PrismaReplica');
    (client as unknown as PrismaClient<'query'>).$on('query', (e) => {
      logger.debug(`${String(e.duration)} ms ${e.query}`);
    });
  }
  return client;
}
