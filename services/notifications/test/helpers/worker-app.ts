// The service inside the test: WorkerModule exactly as main.worker.ts boots it. Database: this
// file's copy of the template; broker: this file's vhost; mail server: the run's (test/setup/db.ts).
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { WorkerModule } from '../../src/entrypoints/worker.module';

import type { Type } from '@nestjs/common';

export interface WorkerApp {
  /** A provider of the running service: for a test that calls what a timer would. */
  get<T>(token: Type<T>): T;
  close(): Promise<void>;
}

export async function createWorkerApp(): Promise<WorkerApp> {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    // quiet, not blind: a rejected message is an error by design, and the suite provokes them
    .setLogger(new ConsoleLogger({ logLevels: ['fatal'] }))
    .compile();
  await moduleRef.init(); // module init + bootstrap hooks: the consumer and the dispatcher start

  return {
    get: (token) => moduleRef.get(token, { strict: false }),
    close: () => moduleRef.close(),
  };
}
