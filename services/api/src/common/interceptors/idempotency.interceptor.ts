import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { from, lastValueFrom, map } from 'rxjs';

import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeyInvalidError,
} from '@shared/errors/idempotency-key.error';
import { IDEMPOTENCY, type Idempotency } from '@shared/http/idempotency';

import type { RequestWithActor } from '../decorators/current-actor.decorator';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON with the keys of every object in one order: `{a,b}` and `{b,a}` are one request. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  // a request without a body: Express leaves `undefined`, which JSON cannot spell
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** What makes two requests with one key the same request: the body, as the client sent it. */
export const fingerprintOf = (body: unknown): string =>
  createHash('sha256').update(canonical(body)).digest('hex');

/**
 * Makes a write safe to retry (http/api-conventions.md §5, docs/adr/0018): the route needs an
 * `Idempotency-Key`, and a request that comes again with the key of an earlier one gets the
 * earlier answer, status and body, without the handler running a second time.
 *
 * Route-level on purpose (`@Idempotent()`): it wraps the handler in the transaction that
 * records the key, and that transaction has to commit inside the global interceptors, which
 * act on what was committed (the `Location` header, the read-your-writes marker).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(IDEMPOTENCY) private readonly idempotency: Idempotency) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithActor>();
    const res = http.getResponse<Response>();

    const key = req.header(IDEMPOTENCY_KEY_HEADER);
    if (key === undefined || !UUID.test(key)) throw new IdempotencyKeyInvalidError();
    // behind the auth guard by construction: an anonymous route has nobody to scope a key to
    if (!req.actor) throw new Error(`@Idempotent() on a route without an actor: ${req.path}`);
    res.setHeader(IDEMPOTENCY_KEY_HEADER, key);

    const outcome = this.idempotency.once(
      {
        userId: req.actor.userId,
        scope: `${req.method} ${req.path}`,
        key: key.toLowerCase(),
        fingerprint: fingerprintOf(req.body),
      },
      async () => ({
        body: await lastValueFrom(next.handle(), { defaultValue: undefined }),
        // set by Nest from @HttpCode before the interceptors run
        status: res.statusCode,
      }),
    );

    return from(outcome).pipe(
      map(({ response, replayed }) => {
        if (replayed) res.status(response.status);
        return response.body;
      }),
    );
  }
}
