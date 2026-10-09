// The service inside the test: WorkerModule exactly as main.worker.ts boots it. Database: this
// file's copy of the template; broker: this file's vhost (test/setup/db.ts).
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { WorkerModule } from '../../src/entrypoints/worker.module';

export interface WorkerApp {
  close(): Promise<void>;
}

export async function createWorkerApp(): Promise<WorkerApp> {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    // quiet, not blind: a rejected message is an error by design, and the suite provokes them
    .setLogger(new ConsoleLogger({ logLevels: ['fatal'] }))
    .compile();
  await moduleRef.init(); // module init + bootstrap hooks: the consumer starts

  return { close: () => moduleRef.close() };
}
