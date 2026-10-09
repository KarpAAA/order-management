// The whole API process inside the test: every module, guard, pipe and filter, configured
// by the same configureApi() as main.api.ts. No port: Supertest calls the http.Server directly.
// Database: this file's copy of the template (db.ts); Redis: the run's container; env: .env.test.
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '@infra/database/prisma.service';

import { ApiModule } from '../../src/entrypoints/api.module';
import { configureApi } from '../../src/entrypoints/configure-api';

import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export interface ApiApp {
  /**
   * One request to the API. Every request carries an `Idempotency-Key` of its own, as a
   * well-behaved client sends one: the routes that need it get it, the others ignore it. A
   * test about the key sets its own (`.set('Idempotency-Key', …)`) or sends none
   * (`.unset('Idempotency-Key')`).
   */
  http(): ReturnType<typeof request>;
  /**
   * Runs `work` and returns how many data statements the app sent meanwhile. The frame around
   * a tenant query (BEGIN, set_config, COMMIT) is not counted: it is constant per query.
   */
  countQueries(work: () => Promise<unknown>): Promise<number>;
  get<T>(token: Type<T> | string | symbol): T;
  /** Every route the app registered, as `GET /v1/workspaces/:workspaceId/orders`. */
  routes(): string[];
  close(): Promise<void>;
}

const TRANSACTION_FRAME = /^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config\()/i;

export async function createApiApp(): Promise<ApiApp> {
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
    // quiet, not blind: every 4xx is a warn by design, and the suite provokes hundreds of them
    .setLogger(new ConsoleLogger({ logLevels: ['fatal', 'error'] }))
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApi(app);
  await app.init();

  let queries = 0;
  app.get(PrismaService).onQuery((event) => {
    if (!TRANSACTION_FRAME.test(event.query)) queries += 1;
  });

  return {
    http: () => request.agent(app.getHttpServer()).set('Idempotency-Key', uuidv7()),
    countQueries: async (work) => {
      const before = queries;
      await work();
      return queries - before;
    },
    get: (token) => app.get(token),
    routes: () => registeredRoutes(app),
    close: () => app.close(),
  };
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Reads Express 5's router (`app.router.stack`); each route layer knows its path and verbs. */
function registeredRoutes(app: NestExpressApplication): string[] {
  // Express's own types hide `route.methods`; the router is read as the plain object it is
  const express = app.getHttpAdapter().getInstance() as unknown as {
    router: { stack: ExpressLayer[] };
  };
  return express.router.stack.flatMap(({ route }) =>
    route
      ? Object.keys(route.methods)
          .filter((method) => method !== '_all')
          .map((method) => `${method.toUpperCase()} ${route.path}`)
      : [],
  );
}
