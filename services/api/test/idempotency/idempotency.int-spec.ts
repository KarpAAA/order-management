// The idempotency keys against a real Postgres, as the application role (IDK-002…008): what
// is recorded with a request and when, what a known key gets, and what two requests with one
// key do at the same moment. The subject is PostgresIdempotency and its transaction, so the
// test drives it directly; the HTTP side is idempotency.e2e-spec.ts.
import { TransactionHost } from '@nestjs-cls/transactional';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TenantContext } from '@common/tenancy/tenant-context';
import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { IdempotencyCleanup } from '@infra/idempotency/idempotency-cleanup';
import { PostgresIdempotency } from '@infra/idempotency/postgres-idempotency';
import { Clock, SystemClock } from '@shared/domain/clock';
import {
  IdempotencyKeyInProgressError,
  IdempotencyKeyReusedError,
} from '@shared/errors/idempotency-key.error';
import type { IdempotentRequest, StoredResponse } from '@shared/http/idempotency';

import { gate } from '../helpers/concurrency';
import { createIntModule, type IntModule } from '../helpers/int-module';
import { USER_ACME_MEMBER, USER_GLOBEX_MEMBER, WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

let app: IntModule;
let idempotency: PostgresIdempotency;
let cleanup: IdempotencyCleanup;
let tenant: TenantContext;
let txHost: TransactionHost<DbTransactionAdapter>;

beforeAll(async () => {
  app = await createIntModule({
    providers: [PostgresIdempotency, IdempotencyCleanup, { provide: Clock, useClass: SystemClock }],
  });
  idempotency = app.get(PostgresIdempotency);
  cleanup = app.get(IdempotencyCleanup);
  tenant = app.get(TenantContext);
  txHost = app.get(TransactionHost);
});
afterAll(() => app.close());

beforeEach(async () => {
  await testDb().idempotencyKey.deleteMany();
});

const SCOPE = `POST /v1/workspaces/${WS_ACME}/orders`;
const CREATED: StoredResponse = {
  status: 201,
  body: { id: '01990000-0000-7000-8000-a20000000001' },
};

const request = (overrides: Partial<IdempotentRequest> = {}): IdempotentRequest => ({
  userId: USER_ACME_MEMBER,
  scope: SCOPE,
  key: uuidv7(),
  fingerprint: 'fp-1',
  ...overrides,
});

/** A request as the interceptor makes it: the tenant bound by the guard first, then the keys. */
const once = (req: IdempotentRequest, handle: () => Promise<StoredResponse>) =>
  tenant.runInWorkspace(WS_ACME, () => idempotency.once(req, handle));

const rows = () => testDb().idempotencyKey.findMany({ orderBy: { createdAt: 'asc' } });

/** What a handler writes: a product of acme, visible only once the transaction commits. */
const writeProduct = (sku: string) =>
  txHost.tx.product.create({
    data: { workspaceId: WS_ACME, id: uuidv7(), sku, name: sku, priceMinor: 100n },
  });
const productCount = (sku: string) => testDb().product.count({ where: { sku } });

describe('a request is recorded with what it did (IDK-002, IDK-007)', () => {
  it('runs the handler, returns its answer and stores it under the key', async () => {
    const req = request();

    const outcome = await once(req, () => Promise.resolve(CREATED));

    expect(outcome).toEqual({ replayed: false, response: CREATED });
    expect(await rows()).toEqual([
      expect.objectContaining({
        userId: USER_ACME_MEMBER,
        scope: SCOPE,
        key: req.key,
        fingerprint: 'fp-1',
        statusCode: 201,
        response: CREATED.body,
        createdAt: expect.any(Date),
      }),
    ]);
  });

  it('commits the key and the write of the handler together', async () => {
    const sku = `IDK-${uuidv7()}`;

    await once(request(), async () => {
      await writeProduct(sku);
      return CREATED;
    });

    expect(await productCount(sku)).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it('IDK-007 a handler that fails leaves neither its write nor the key', async () => {
    const sku = `IDK-${uuidv7()}`;
    const req = request();

    await expect(
      once(req, async () => {
        await writeProduct(sku);
        throw new Error('refused after the write');
      }),
    ).rejects.toThrow('refused after the write');

    expect(await productCount(sku)).toBe(0);
    expect(await rows()).toEqual([]);

    // the key is free: the retry is handled
    const retry = await once(req, () => Promise.resolve(CREATED));
    expect(retry.replayed).toBe(false);
  });

  it('stores an answer without a body', async () => {
    const req = request();
    await once(req, () => Promise.resolve({ status: 204, body: undefined }));

    const again = await once(req, () => Promise.reject(new Error('must not run')));

    expect(again).toEqual({ replayed: true, response: { status: 204, body: undefined } });
  });
});

describe('a key that is known (IDK-003, IDK-004, IDK-005)', () => {
  it('IDK-003 returns the stored answer and does not run the handler again', async () => {
    const req = request();
    await once(req, () => Promise.resolve(CREATED));
    let ran = 0;

    const again = await once(req, () => {
      ran += 1;
      return Promise.resolve({ status: 201, body: { id: 'another' } });
    });

    expect(again).toEqual({ replayed: true, response: CREATED });
    expect(ran).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it('IDK-004 refuses the key with another fingerprint and changes nothing', async () => {
    const req = request();
    await once(req, () => Promise.resolve(CREATED));

    await expect(
      once({ ...req, fingerprint: 'fp-2' }, () => Promise.reject(new Error('must not run'))),
    ).rejects.toThrow(IdempotencyKeyReusedError);

    expect(await rows()).toEqual([expect.objectContaining({ fingerprint: 'fp-1' })]);
  });

  it.each([
    ['another user', { userId: USER_GLOBEX_MEMBER }],
    ['another route', { scope: `${SCOPE}/x/place` }],
  ])('IDK-005 the same key of %s is a key of its own', async (_case, other) => {
    const req = request();
    await once(req, () => Promise.resolve(CREATED));

    const outcome = await once({ ...req, ...other }, () =>
      Promise.resolve({ status: 202, body: { id: 'other' } }),
    );

    expect(outcome).toEqual({ replayed: false, response: { status: 202, body: { id: 'other' } } });
    expect(await rows()).toHaveLength(2);
  });
});

describe('two requests with one key at the same moment (IDK-006)', () => {
  it('the second is told to come back, without waiting, and the first is done once', async () => {
    const req = request();
    const inside = gate();
    const release = gate();
    let ran = 0;

    const first = once(req, async () => {
      ran += 1;
      inside.open();
      await release.opened; // the first request is still being handled
      return CREATED;
    });
    await inside.opened;

    const startedAt = Date.now();
    await expect(
      once(req, () => {
        ran += 1;
        return Promise.resolve(CREATED);
      }),
    ).rejects.toThrow(IdempotencyKeyInProgressError);
    // refused at once: it did not queue behind the transaction of the first
    expect(Date.now() - startedAt).toBeLessThan(1000);

    release.open();
    await expect(first).resolves.toEqual({ replayed: false, response: CREATED });
    expect(ran).toBe(1);

    // and once the first is answered, the same key gets that answer
    expect(await once(req, () => Promise.reject(new Error('must not run')))).toEqual({
      replayed: true,
      response: CREATED,
    });
  });

  it('does not hold up a request with another key', async () => {
    const inside = gate();
    const release = gate();
    const first = once(request(), async () => {
      inside.open();
      await release.opened;
      return CREATED;
    });
    await inside.opened;

    await expect(once(request(), () => Promise.resolve(CREATED))).resolves.toMatchObject({
      replayed: false,
    });

    release.open();
    await first;
  });
});

describe('retention (IDK-008)', () => {
  it('deletes the keys recorded before the cutoff and keeps the others', async () => {
    const old = request();
    const recent = request();
    await once(old, () => Promise.resolve(CREATED));
    await once(recent, () => Promise.resolve(CREATED));
    await testDb().idempotencyKey.updateMany({
      where: { key: old.key },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const deleted = await cleanup.deleteCreatedBefore(new Date(Date.now() - 24 * 60 * 60 * 1000));

    expect(deleted).toBe(1);
    expect((await rows()).map((row) => row.key)).toEqual([recent.key]);
  });

  it('a key that was deleted is unknown: its request is handled anew', async () => {
    const req = request();
    await once(req, () => Promise.resolve(CREATED));
    await cleanup.deleteCreatedBefore(new Date(Date.now() + 1000));

    const outcome = await once(req, () => Promise.resolve({ status: 201, body: { id: 'second' } }));

    expect(outcome.replayed).toBe(false);
  });
});

describe('idempotency_keys — constraints of the table', () => {
  it('refuses a status that is not a success: only an answered write is remembered', async () => {
    await expect(
      testDb().idempotencyKey.create({
        data: {
          userId: USER_ACME_MEMBER,
          scope: SCOPE,
          key: uuidv7(),
          fingerprint: 'fp',
          statusCode: 409,
          createdAt: new Date(),
        },
      }),
    ).rejects.toThrow('idempotency_keys_status_code_chk');
  });
});
