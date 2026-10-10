// The service inside the test: WorkerModule exactly as main.worker.ts boots it. Database: this
// file's copy of the template; broker: this file's vhost (test/setup/db.ts).
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { LOG_DESTINATION } from '@infra/logger/logger.module';

import { WorkerModule } from '../../src/entrypoints/worker.module';

import { captureLogs } from './log-capture';

import type { LogLine } from './log-capture';

export interface WorkerApp {
  /** Every line the service has logged so far, oldest first. */
  logs(): LogLine[];
  close(): Promise<void>;
}

export async function createWorkerApp(): Promise<WorkerApp> {
  const logs = captureLogs();
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    // the log of the service goes to memory: a rejected message is an error by design, and
    // the suite provokes them
    .overrideProvider(LOG_DESTINATION)
    .useValue(logs.destination)
    // what Nest itself says, which the entrypoint hands to the same logger
    .setLogger(new ConsoleLogger({ logLevels: ['fatal'] }))
    .compile();
  await moduleRef.init(); // module init + bootstrap hooks: the consumer starts

  return { logs: () => logs.lines(), close: () => moduleRef.close() };
}
