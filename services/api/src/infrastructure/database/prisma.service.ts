import { Inject, Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { databaseConfig, type DatabaseConfig } from '@config/configuration';

import { PrismaClient } from './generated/prisma/client';

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
