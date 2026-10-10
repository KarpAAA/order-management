// The worker process inside the test: WorkerModule exactly as main.worker.ts boots it. It
// shares only the database, Redis and the broker with the API app of the same file, as the
// two processes do in production (api+worker).
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { LOG_DESTINATION } from '@infra/logger/logger.module';

import { WorkerModule } from '../../src/entrypoints/worker.module';

import { captureLogs } from './log-capture';

import type { LogLine } from './log-capture';
import type { Type } from '@nestjs/common';

export interface WorkerApp {
  get<T>(token: Type<T> | string | symbol): T;
  /** Every line the worker has logged so far, oldest first. */
  logs(): LogLine[];
  close(): Promise<void>;
}

export async function createWorkerApp(): Promise<WorkerApp> {
  const logs = captureLogs();
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    // the log of the worker goes to memory: a rejected message is an error by design, and
    // the suite provokes them
    .overrideProvider(LOG_DESTINATION)
    .useValue(logs.destination)
    // what Nest itself says, which the entrypoint hands to the same logger
    .setLogger(new ConsoleLogger({ logLevels: ['fatal'] }))
    .compile();
  await moduleRef.init(); // module init + bootstrap hooks: the queue worker and the broker consumer start

  return {
    get: (token) => moduleRef.get(token),
    logs: () => logs.lines(),
    close: () => moduleRef.close(),
  };
}
