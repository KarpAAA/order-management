import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import type { Prisma } from '@infra/database/generated/prisma/client';
import { Clock } from '@shared/domain/clock';
import {
  IdempotencyKeyInProgressError,
  IdempotencyKeyReusedError,
} from '@shared/errors/idempotency-key.error';
import type {
  Idempotency,
  IdempotentOutcome,
  IdempotentRequest,
  StoredResponse,
} from '@shared/http/idempotency';

/**
 * The idempotency keys in the database of the service (docs/adr/0018-http-idempotency-key.md):
 * the record of a key and what its request did are committed together, or neither is. The
 * inbox of the HTTP side (compare infrastructure/inbox/postgres-inbox.ts).
 *
 *  - the transaction begins here, and the `@Transactional()` use case inside joins it, so
 *    the tenant must be bound before the call (the workspace guard has done that);
 *  - a transaction-level advisory lock on the key comes first. A second request with the key
 *    does not wait for the first: it does not get the lock and is told to come back. The only
 *    kind of advisory lock PgBouncer allows (docs/adr/0008);
 *  - the record is written last, with the response. A request that fails rolls everything
 *    back, so its key is free for the retry.
 */
@Injectable()
export class PostgresIdempotency implements Idempotency {
  constructor(
    private readonly txHost: TransactionHost<DbTransactionAdapter>,
    private readonly clock: Clock,
  ) {}

  once(
    request: IdempotentRequest,
    handle: () => Promise<StoredResponse>,
  ): Promise<IdempotentOutcome> {
    const { userId, scope, key, fingerprint } = request;
    return this.txHost.withTransaction(async () => {
      const { tx } = this.txHost;
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${`idempotency:${userId}:${scope}:${key}`}, 0)
        ) AS locked`;
      if (!lock?.locked) throw new IdempotencyKeyInProgressError(key);

      const stored = await tx.idempotencyKey.findUnique({
        where: { userId_scope_key: { userId, scope, key } },
        select: { fingerprint: true, statusCode: true, response: true },
      });
      if (stored) {
        if (stored.fingerprint !== fingerprint) throw new IdempotencyKeyReusedError(key);
        return {
          replayed: true,
          response: { status: stored.statusCode, body: stored.response ?? undefined },
        };
      }

      const response = await handle();
      await tx.idempotencyKey.create({
        data: {
          userId,
          scope,
          key,
          fingerprint,
          statusCode: response.status,
          // a route without a body (204) stores none
          ...(response.body !== undefined && { response: response.body as Prisma.InputJsonValue }),
          createdAt: this.clock.now(),
        },
      });
      return { replayed: false, response };
    });
  }
}
