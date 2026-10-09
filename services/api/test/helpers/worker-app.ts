// The worker process inside the test: WorkerModule exactly as main.worker.ts boots it. It
// shares only the database, Redis and the broker with the API app of the same file, as the
// two processes do in production (api+worker).
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { WorkerModule } from '../../src/entrypoints/worker.module';

import type { Type } from '@nestjs/common';

export interface WorkerApp {
  get<T>(token: Type<T> | string | symbol): T;
  close(): Promise<void>;
}

export async function createWorkerApp(): Promise<WorkerApp> {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    // quiet, not blind: a rejected message is an error by design, and the suite provokes them
    .setLogger(new ConsoleLogger({ logLevels: ['fatal'] }))
    .compile();
  await moduleRef.init(); // module init + bootstrap hooks: the queue worker and the broker consumer start

  return {
    get: (token) => moduleRef.get(token),
    close: () => moduleRef.close(),
  };
}
