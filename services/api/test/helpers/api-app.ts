// The whole API process inside the test: every module, guard, pipe and filter, configured
// by the same configureApi() as main.api.ts. No port: Supertest calls the http.Server directly.
// Database: this file's copy of the template (db.ts); Redis: the run's container; env: .env.test.
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaService } from '@infra/database/prisma.service';

import { ApiModule } from '../../src/entrypoints/api.module';
import { configureApi } from '../../src/entrypoints/configure-api';

import type { NestExpressApplication } from '@nestjs/platform-express';

export interface ApiApp {
  http(): ReturnType<typeof request>;
  /** Runs `work` and returns how many SQL statements the app sent meanwhile. */
  countQueries(work: () => Promise<unknown>): Promise<number>;
  close(): Promise<void>;
}

export async function createApiApp(): Promise<ApiApp> {
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
    .setLogger(new ConsoleLogger({ logLevels: ['fatal', 'error', 'warn'] })) // quiet, not blind
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApi(app);
  await app.init();

  let queries = 0;
  app.get(PrismaService).onQuery(() => {
    queries += 1;
  });

  return {
    http: () => request(app.getHttpServer()),
    countQueries: async (work) => {
      const before = queries;
      await work();
      return queries - before;
    },
    close: () => app.close(),
  };
}
