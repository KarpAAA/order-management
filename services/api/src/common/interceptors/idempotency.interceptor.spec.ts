import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { userActor } from '@shared/auth/actor';
import {
  IdempotencyKeyInvalidError,
  IdempotencyKeyReusedError,
} from '@shared/errors/idempotency-key.error';
import type {
  Idempotency,
  IdempotentOutcome,
  IdempotentRequest,
  StoredResponse,
} from '@shared/http/idempotency';

import { fingerprintOf, IdempotencyInterceptor } from './idempotency.interceptor';

import type { CallHandler, ExecutionContext } from '@nestjs/common';

const USER = '01990000-0000-7000-8000-c000000000a3';
const KEY = '01990000-0000-7000-8000-e00000000001';
const PATH = '/v1/workspaces/w1/orders';

/** The keys without a database: an answer is remembered when its handler returns, as on commit. */
class MemoryIdempotency implements Idempotency {
  readonly seen: IdempotentRequest[] = [];
  private readonly stored = new Map<string, { fingerprint: string; response: StoredResponse }>();

  async once(
    request: IdempotentRequest,
    handle: () => Promise<StoredResponse>,
  ): Promise<IdempotentOutcome> {
    this.seen.push(request);
    const id = `${request.userId} ${request.scope} ${request.key}`;
    const known = this.stored.get(id);
    if (known) {
      if (known.fingerprint !== request.fingerprint)
        throw new IdempotencyKeyReusedError(request.key);
      return { replayed: true, response: known.response };
    }
    const response = await handle();
    this.stored.set(id, { fingerprint: request.fingerprint, response });
    return { replayed: false, response };
  }
}

interface Sent {
  key?: string | undefined;
  body?: unknown;
  user?: string | null;
  path?: string;
  /** What Nest set from @HttpCode before the interceptors run. */
  status?: number;
}

/** One request through the interceptor: what the handler returned, and what the response got. */
function send(interceptor: IdempotencyInterceptor, handler: CallHandler, sent: Sent = {}) {
  const { key = KEY, body = { items: [] }, user = USER, path = PATH, status = 201 } = sent;
  const res = {
    statusCode: status,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  const req = {
    method: 'POST',
    path,
    body,
    actor: user === null ? undefined : userActor(user),
    header: (name: string) =>
      name.toLowerCase() === 'idempotency-key' ? (sent.key ?? key) : undefined,
  };
  if ('key' in sent && sent.key === undefined) req.header = () => undefined;
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { res, result: () => lastValueFrom(interceptor.intercept(context, handler)) };
}

const handlerReturning = (body: unknown) => {
  const handle = vi.fn(() => of(body));
  return { handler: { handle } as CallHandler, handle };
};

describe('IdempotencyInterceptor', () => {
  it('IDK-002 lets the first request through, and tells the store whose key it is and for what', async () => {
    const store = new MemoryIdempotency();
    const { handler, handle } = handlerReturning({ id: 'o1' });

    const { res, result } = send(new IdempotencyInterceptor(store), handler);

    await expect(result()).resolves.toEqual({ id: 'o1' });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(store.seen).toEqual([
      {
        userId: USER,
        scope: `POST ${PATH}`,
        key: KEY,
        fingerprint: fingerprintOf({ items: [] }),
      },
    ]);
    expect(res.statusCode).toBe(201);
    expect(res.headers['Idempotency-Key']).toBe(KEY);
  });

  it('IDK-003 answers the same key again with the stored status and body, without the handler', async () => {
    const store = new MemoryIdempotency();
    const interceptor = new IdempotencyInterceptor(store);
    const first = handlerReturning({ id: 'o1' });
    await send(interceptor, first.handler, { status: 202 }).result();
    const second = handlerReturning({ id: 'another' });

    // Nest starts every request with the status of the route; a replay must not depend on it
    const { res, result } = send(interceptor, second.handler, { status: 200 });

    await expect(result()).resolves.toEqual({ id: 'o1' });
    expect(second.handle).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(202);
    expect(res.headers['Idempotency-Key']).toBe(KEY);
  });

  it('IDK-003 stores an answer without a body as one', async () => {
    const store = new MemoryIdempotency();
    const interceptor = new IdempotencyInterceptor(store);
    await send(interceptor, handlerReturning(undefined).handler, { status: 204 }).result();
    const second = handlerReturning({ unexpected: true });

    const { res, result } = send(interceptor, second.handler, { status: 204 });

    await expect(result()).resolves.toBeUndefined();
    expect(second.handle).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(204);
  });

  it('IDK-004 refuses the key with another body', async () => {
    const store = new MemoryIdempotency();
    const interceptor = new IdempotencyInterceptor(store);
    await send(interceptor, handlerReturning({ id: 'o1' }).handler).result();
    const second = handlerReturning({ id: 'o2' });

    const { result } = send(interceptor, second.handler, { body: { items: [{ quantity: 2 }] } });

    await expect(result()).rejects.toThrow(IdempotencyKeyReusedError);
    expect(second.handle).not.toHaveBeenCalled();
  });

  it('IDK-005 the same key of another user, or on another path, is a new one', async () => {
    const store = new MemoryIdempotency();
    const interceptor = new IdempotencyInterceptor(store);
    await send(interceptor, handlerReturning({ id: 'o1' }).handler).result();
    const other = '01990000-0000-7000-8000-c000000000b3';

    const byOther = handlerReturning({ id: 'o2' });
    const elsewhere = handlerReturning({ id: 'o3' });
    await send(interceptor, byOther.handler, { user: other }).result();
    await send(interceptor, elsewhere.handler, { path: '/v1/workspaces/w2/orders' }).result();

    expect(byOther.handle).toHaveBeenCalledTimes(1);
    expect(elsewhere.handle).toHaveBeenCalledTimes(1);
  });

  it('IDK-007 does not remember a request whose handler failed: the key is handled again', async () => {
    const store = new MemoryIdempotency();
    const interceptor = new IdempotencyInterceptor(store);
    const failing = { handle: () => throwError(() => new Error('database is down')) };
    await expect(send(interceptor, failing).result()).rejects.toThrow('database is down');
    const retry = handlerReturning({ id: 'o1' });

    await expect(send(interceptor, retry.handler).result()).resolves.toEqual({ id: 'o1' });

    expect(retry.handle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['a key that is not a uuid', 'order-1'],
    ['a uuid with something after it', `${KEY}-x`],
  ])('IDK-001 refuses %s before anything is done', (_case, key) => {
    const store = new MemoryIdempotency();
    const { handler, handle } = handlerReturning({ id: 'o1' });

    expect(() => send(new IdempotencyInterceptor(store), handler, { key }).result()).toThrow(
      IdempotencyKeyInvalidError,
    );

    expect(handle).not.toHaveBeenCalled();
    expect(store.seen).toEqual([]);
  });

  it('treats a key as the same whatever its case', async () => {
    const store = new MemoryIdempotency();
    const interceptor = new IdempotencyInterceptor(store);
    await send(interceptor, handlerReturning({ id: 'o1' }).handler).result();
    const second = handlerReturning({ id: 'o2' });

    await send(interceptor, second.handler, { key: KEY.toUpperCase() }).result();

    expect(second.handle).not.toHaveBeenCalled();
  });

  it('refuses to run on a route without an actor: there is nobody to scope the key to', () => {
    const { handler } = handlerReturning({ id: 'o1' });

    expect(() =>
      send(new IdempotencyInterceptor(new MemoryIdempotency()), handler, { user: null }).result(),
    ).toThrow(/without an actor/);
  });
});

describe('fingerprintOf', () => {
  it('IDK-004 is the same for a body whose keys come in another order', () => {
    const a = { version: 1, items: [{ productId: 'p1', quantity: 2 }], discount: { type: 'NONE' } };
    const b = { discount: { type: 'NONE' }, items: [{ quantity: 2, productId: 'p1' }], version: 1 };

    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it.each([
    ['another value', { version: 2 }],
    ['another field', { version: 1, extra: true }],
    ['a string where a number was', { version: '1' }],
  ])('differs for %s', (_case, body) => {
    expect(fingerprintOf(body)).not.toBe(fingerprintOf({ version: 1 }));
  });

  it('keeps the order of an array: two items swapped are another request', () => {
    expect(fingerprintOf({ items: [1, 2] })).not.toBe(fingerprintOf({ items: [2, 1] }));
  });

  it('gives a request without a body a fingerprint too', () => {
    expect(fingerprintOf(undefined)).toBe(fingerprintOf(undefined));
    expect(fingerprintOf(undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});
