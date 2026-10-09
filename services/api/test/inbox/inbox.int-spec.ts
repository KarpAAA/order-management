// The inbox against a real Postgres, as the application role (IBX-001…005): what a consumer
// can rely on when the same message reaches it again, also at the same moment. The handler
// here is one that is NOT idempotent on its own: it writes a row every time it runs, in the
// transaction it is given. What a real consumer does with it: test/orders/payment-flow.e2e-spec.ts.
import { TransactionHost } from '@nestjs-cls/transactional';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TenantContext } from '@common/tenancy/tenant-context';
import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { InboxCleanup } from '@infra/inbox/inbox-cleanup';
import { PostgresInbox } from '@infra/inbox/postgres-inbox';
import { Clock, SystemClock } from '@shared/domain/clock';

import { createIntModule, type IntModule } from '../helpers/int-module';
import { WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

const CONSUMER = 'api.payment-events';
const DELIVERIES = 5;

let app: IntModule;
let inbox: PostgresInbox;
let cleanup: InboxCleanup;
let tenant: TenantContext;
let txHost: TransactionHost<DbTransactionAdapter>;

beforeAll(async () => {
  app = await createIntModule({
    providers: [PostgresInbox, InboxCleanup, { provide: Clock, useClass: SystemClock }],
  });
  inbox = app.get(PostgresInbox);
  cleanup = app.get(InboxCleanup);
  tenant = app.get(TenantContext);
  txHost = app.get<TransactionHost<DbTransactionAdapter>>(TransactionHost);
});
afterAll(() => app.close());

beforeEach(async () => {
  await testDb().inboxMessage.deleteMany();
  await testDb().outboxMessage.deleteMany();
});

/**
 * One effect of handling a message: a row, written through the transaction that is open. The
 * pause keeps the transaction open long enough for the other deliveries to run into it.
 */
async function effect(): Promise<void> {
  const id = uuidv7();
  await txHost.tx.outboxMessage.create({
    data: {
      id,
      exchange: 'events',
      routingKey: 'test.effect',
      payload: { messageId: id, name: 'test.effect' },
      occurredAt: new Date(),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** A delivery as a consumer makes it: the tenant bound first, then the inbox. */
const deliver = (messageId: string, handle = effect, consumer = CONSUMER) =>
  tenant.runInWorkspace(WS_ACME, () => inbox.once(consumer, messageId, handle));

const effects = () => testDb().outboxMessage.count();
const recorded = () =>
  testDb().inboxMessage.findMany({ orderBy: [{ consumer: 'asc' }, { messageId: 'asc' }] });

describe('a message is handled once per consumer (IBX-001)', () => {
  it('runs the handler for the first delivery and records the message', async () => {
    const messageId = uuidv7();

    await expect(deliver(messageId)).resolves.toBe(true);

    expect(await effects()).toBe(1);
    expect(await recorded()).toEqual([
      { consumer: CONSUMER, messageId, processedAt: expect.any(Date) as Date },
    ]);
  });

  it('does not run it for the deliveries that follow', async () => {
    const messageId = uuidv7();

    const results: boolean[] = [];
    for (let delivery = 0; delivery < DELIVERIES; delivery += 1) {
      results.push(await deliver(messageId));
    }

    expect(results).toEqual([true, false, false, false, false]);
    expect(await effects()).toBe(1);
    expect(await recorded()).toHaveLength(1);
  });

  it('handles another message with the same content: only the id makes a duplicate', async () => {
    await deliver(uuidv7());
    await deliver(uuidv7());

    expect(await effects()).toBe(2);
  });
});

describe('deliveries of one message at the same moment (IBX-003)', () => {
  it('one of them runs the handler; the others wait for it and find the message recorded', async () => {
    const messageId = uuidv7();

    const results = await Promise.all(Array.from({ length: DELIVERIES }, () => deliver(messageId)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await effects()).toBe(1);
    expect(await recorded()).toHaveLength(1);
  });

  it('one of them fails: a delivery that waited for it handles the message', async () => {
    const messageId = uuidv7();
    let first = true;
    const failingOnce = async (): Promise<void> => {
      const fail = first;
      first = false;
      await effect();
      if (fail) throw new Error('handler failed');
    };

    const results = await Promise.allSettled(
      Array.from({ length: DELIVERIES }, () => deliver(messageId, failingOnce)),
    );

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value)).toHaveLength(1);
    // the effect of the failed delivery went with its transaction
    expect(await effects()).toBe(1);
    expect(await recorded()).toHaveLength(1);
  });
});

describe('the record and the effect are one transaction (IBX-002)', () => {
  it('a handler that throws leaves neither, and the next delivery handles the message', async () => {
    const messageId = uuidv7();
    const failing = async (): Promise<void> => {
      await effect();
      throw new Error('handler failed');
    };

    await expect(deliver(messageId, failing)).rejects.toThrow('handler failed');
    expect(await effects()).toBe(0);
    expect(await recorded()).toEqual([]);

    await expect(deliver(messageId)).resolves.toBe(true);
    expect(await effects()).toBe(1);
  });
});

describe('each consumer has its own record (IBX-004)', () => {
  it('two consumers of one message each handle it once', async () => {
    const messageId = uuidv7();

    await deliver(messageId, effect, 'api.payment-events');
    await deliver(messageId, effect, 'api.other-events');
    await deliver(messageId, effect, 'api.other-events');

    expect(await effects()).toBe(2);
    expect((await recorded()).map((row) => row.consumer)).toEqual([
      'api.other-events',
      'api.payment-events',
    ]);
  });
});

describe('retention (IBX-005)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('deletes the records of the messages handled before the cutoff, and nothing else', async () => {
    const now = Date.now();
    const [old, recent] = [uuidv7(), uuidv7()];
    await testDb().inboxMessage.createMany({
      data: [
        { consumer: CONSUMER, messageId: old, processedAt: new Date(now - 8 * DAY_MS) },
        { consumer: CONSUMER, messageId: recent, processedAt: new Date(now - 6 * DAY_MS) },
      ],
    });

    const deleted = await cleanup.deleteProcessedBefore(new Date(now - 7 * DAY_MS));

    expect(deleted).toBe(1);
    expect((await recorded()).map((row) => row.messageId)).toEqual([recent]);
  });

  it('a message whose record is gone is handled again: the retention is the window', async () => {
    const messageId = uuidv7();
    await deliver(messageId);
    await cleanup.deleteProcessedBefore(new Date(Date.now() + DAY_MS));

    await expect(deliver(messageId)).resolves.toBe(true);
    expect(await effects()).toBe(2);
  });
});
