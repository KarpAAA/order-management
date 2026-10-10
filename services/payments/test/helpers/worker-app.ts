// The service inside the test: WorkerModule exactly as main.worker.ts boots it, with the
// payment provider replaced by a test double. Database: this file's copy of the template;
// broker: this file's vhost (test/setup/db.ts).
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { GatewayConfig } from '@config/configuration';
import { LOG_DESTINATION } from '@infra/logger/logger.module';
import { silentLogger } from '@shared/logger/silent-logger';

import { HttpPaymentGateway } from '@modules/payments/infrastructure/http-payment-gateway.adapter';
import { PAYMENT_GATEWAY, type PaymentGateway } from '@modules/payments/ports/payment-gateway.port';

import { WorkerModule } from '../../src/entrypoints/worker.module';

import { captureLogs } from './log-capture';

import type { LogLine } from './log-capture';
import type { Type } from '@nestjs/common';

export interface WorkerApp {
  /** A provider of the running service. */
  get<T>(token: Type<T>): T;
  /** Every line the service has logged so far, oldest first. */
  logs(): LogLine[];
  close(): Promise<void>;
}

/**
 * The real HTTP gateway for a test that is about the call itself: the provider is whatever
 * answers `pspBaseUrl` (MSW in the test's process). One call per operation, pauses of
 * milliseconds and a breaker that never opens, unless the test says otherwise.
 */
export function httpGateway(overrides: Partial<GatewayConfig> = {}): PaymentGateway {
  return new HttpPaymentGateway(
    {
      gateway: 'http',
      pspBaseUrl: 'http://psp.test',
      pspTimeoutMs: 1000,
      pspCallBudgetMs: 5000,
      pspMaxRetries: 0,
      pspRetryInitialDelayMs: 5,
      pspRetryMaxDelayMs: 20,
      pspBreakerThreshold: 0.5,
      pspBreakerWindowMs: 10_000,
      pspBreakerMinCalls: 1000,
      pspBreakerHalfOpenMs: 60_000,
      ...overrides,
    },
    silentLogger,
    // built by hand, outside the injector: its calls belong to no chain
    { current: () => undefined },
  );
}

export async function createWorkerApp(gateway: PaymentGateway): Promise<WorkerApp> {
  const logs = captureLogs();
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(PAYMENT_GATEWAY)
    .useValue(gateway)
    // the log of the service goes to memory: a rejected message is an error by design, and
    // the suite provokes them
    .overrideProvider(LOG_DESTINATION)
    .useValue(logs.destination)
    // what Nest itself says, which the entrypoint hands to the same logger
    .setLogger(new ConsoleLogger({ logLevels: ['fatal'] }))
    .compile();
  await moduleRef.init(); // module init + bootstrap hooks: the consumer starts

  return {
    get: (token) => moduleRef.get(token),
    logs: () => logs.lines(),
    close: () => moduleRef.close(),
  };
}
