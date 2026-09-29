// The worker process inside the test: WorkerModule exactly as main.worker.ts boots it, with
// the payment provider replaced by a test double. It shares only the database and Redis with
// the API app of the same file — as the two processes do in production (api+worker).
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PAYMENT_GATEWAY, type PaymentGateway } from '@modules/orders/ports/payment-gateway.port';

import { WorkerModule } from '../../src/entrypoints/worker.module';

import type { Type } from '@nestjs/common';

export interface WorkerApp {
  get<T>(token: Type<T> | string | symbol): T;
  close(): Promise<void>;
}

export async function createWorkerApp(gateway: PaymentGateway): Promise<WorkerApp> {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(PAYMENT_GATEWAY)
    .useValue(gateway)
    .setLogger(new ConsoleLogger({ logLevels: ['fatal', 'error'] }))
    .compile();
  await moduleRef.init(); // module init + bootstrap hooks: the BullMQ worker starts consuming

  return {
    get: (token) => moduleRef.get(token),
    close: () => moduleRef.close(),
  };
}
