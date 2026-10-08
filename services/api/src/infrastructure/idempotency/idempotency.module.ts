import { Global, Module } from '@nestjs/common';

import { IDEMPOTENCY } from '@shared/http/idempotency';

import { PostgresIdempotency } from './postgres-idempotency';

/**
 * The idempotency keys, for every process: what `@Idempotent()` routes record their answers
 * in. Inert: the cleanup of old keys starts in `idempotency.worker.module.ts`.
 */
@Global()
@Module({
  providers: [{ provide: IDEMPOTENCY, useClass: PostgresIdempotency }],
  exports: [IDEMPOTENCY],
})
export class IdempotencyModule {}
