// The service inside the test: WorkerModule exactly as main.worker.ts boots it, with the
// payment provider replaced by a test double. Database: this file's copy of the template;
// broker: this file's vhost (test/setup/db.ts).
import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { GatewayConfig } from '@config/configuration';

import { HttpPaymentGateway } from '@modules/payments/infrastructure/http-payment-gateway.adapter';
import { PAYMENT_GATEWAY, type PaymentGateway } from '@modules/payments/ports/payment-gateway.port';

import { WorkerModule } from '../../src/entrypoints/worker.module';

export interface WorkerApp {
  close(): Promise<void>;
}

/**
 * The real HTTP gateway for a test that is about the call itself: the provider is whatever
 * answers `pspBaseUrl` (MSW in the test's process). One call per operation, pauses of
 * milliseconds and a breaker that never opens, unless the test says otherwise.
 */
export function httpGateway(overrides: Partial<GatewayConfig> = {}): PaymentGateway {
  return new HttpPaymentGateway({
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
  });
}

export async function createWorkerApp(gateway: PaymentGateway): Promise<WorkerApp> {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(PAYMENT_GATEWAY)
    .useValue(gateway)
    // quiet, not blind: a rejected message is an error by design, and the suite provokes them
    .setLogger(new ConsoleLogger({ logLevels: ['fatal'] }))
    .compile();
  await moduleRef.init(); // module init + bootstrap hooks: the consumer starts

  return { close: () => moduleRef.close() };
}
