// The relay against a real Postgres, as the application role (OBX-002, 003, 006, 009): which
// rows a pass takes, in what order, what it marks and what it leaves, and what two relays do
// at once. The broker is a recording stand-in for the publisher port here; the real one is in
// rabbit-outbox.publisher.int-spec.ts.
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { outboxConfig, type OutboxConfig } from '@config/configuration';
import { OutboxCleanup } from '@infra/outbox/outbox-cleanup';
import {
  OUTBOX_PUBLISHER,
  type OutboxPublisher,
  type OutboxRecord,
} from '@infra/outbox/outbox-publisher.port';
import { OutboxRelay } from '@infra/outbox/outbox-relay';
import { Clock, SystemClock } from '@shared/domain/clock';

import { createIntModule, type IntModule } from '../helpers/int-module';
import { testDb } from '../setup/db';

const BATCH = 3;
const CONFIG: OutboxConfig = {
  relayEnabled: true,
  pollIntervalMs: 50,
  batchSize: BATCH,
  publishTimeoutMs: 1000,
  retentionDays: 7,
};

/** The other side of the port: records what the relay hands over, fails or waits on demand. */
class TestPublisher implements OutboxPublisher {
  readonly published: string[] = [];
  failOn: string | undefined;
  /** While set, every publish waits for it: the pass stays inside its transaction. */
  gate: Promise<void> | undefined;

  async publish(record: OutboxRecord): Promise<void> {
    await this.gate;
    if (record.id === this.failOn) throw new Error(`broker refused ${record.id}`);
    this.published.push(record.id);
  }
}

let app: IntModule;
let relay: OutboxRelay;
let cleanup: OutboxCleanup;
let publisher: TestPublisher;

beforeAll(async () => {
  publisher = new TestPublisher();
  app = await createIntModule({
    providers: [
      OutboxRelay,
      OutboxCleanup,
      { provide: OUTBOX_PUBLISHER, useValue: publisher },
      { provide: outboxConfig.KEY, useValue: CONFIG },
      { provide: Clock, useClass: SystemClock },
    ],
  });
  relay = app.get(OutboxRelay);
  cleanup = app.get(OutboxCleanup);
});
afterAll(() => app.close());

beforeEach(async () => {
  await testDb().outboxMessage.deleteMany();
  publisher.published.length = 0;
  publisher.failOn = undefined;
  publisher.gate = undefined;
});

/** `count` unpublished messages, oldest first: a UUIDv7 sorts by the time it was made. */
async function waiting(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => uuidv7()).sort();
  await testDb().outboxMessage.createMany({
    // inserted newest first: the order of a pass must come from the id, not from the heap
    data: [...ids].reverse().map((id) => ({
      id,
      exchange: 'events',
      routingKey: 'orders.order-paid',
      payload: { messageId: id, name: 'orders.order-paid' },
      occurredAt: new Date(),
    })),
  });
  return ids;
}

const unpublished = async (): Promise<string[]> =>
  (
    await testDb().outboxMessage.findMany({
      where: { publishedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true },
    })
  ).map((row) => row.id);

describe('a pass of the relay (OBX-002, OBX-003)', () => {
  it('publishes the waiting messages oldest first and marks them published', async () => {
    const ids = await waiting(BATCH - 1);

    const pass = await relay.pass();

    expect(publisher.published).toEqual(ids);
    expect(pass).toEqual({ skipped: false, published: BATCH - 1, more: false });
    expect(await unpublished()).toEqual([]);
  });

  it('hands the publisher the row as it was stored', async () => {
    const [id] = await waiting(1);
    const handed: OutboxRecord[] = [];
    const original = publisher.publish.bind(publisher);
    publisher.publish = async (record) => {
      handed.push(record);
      await original(record);
    };
    try {
      await relay.pass();
    } finally {
      publisher.publish = original;
    }

    expect(handed).toEqual([
      {
        id,
        exchange: 'events',
        routingKey: 'orders.order-paid',
        payload: { messageId: id, name: 'orders.order-paid' },
      },
    ]);
  });

  it('takes one batch and says that more may be waiting', async () => {
    const ids = await waiting(BATCH + 2);

    const first = await relay.pass();
    const second = await relay.pass();

    expect(first).toMatchObject({ published: BATCH, more: true });
    expect(second).toMatchObject({ published: 2, more: false });
    expect(publisher.published).toEqual(ids);
  });

  it('does nothing when nothing waits, and never publishes a message twice', async () => {
    await waiting(2);
    await relay.pass();

    const pass = await relay.pass();

    expect(pass).toEqual({ skipped: false, published: 0, more: false });
    expect(publisher.published).toHaveLength(2);
  });
});

describe('a message that cannot be published (OBX-003)', () => {
  it('stops the pass: what went before is marked, the message and everything after it wait', async () => {
    const [first, second, third] = await waiting(3);
    publisher.failOn = second;

    const pass = await relay.pass();

    expect(pass).toMatchObject({ skipped: false, published: 1, more: false });
    expect(pass.failure).toEqual(new Error(`broker refused ${second ?? ''}`));
    expect(publisher.published).toEqual([first]);
    expect(await unpublished()).toEqual([second, third]);
  });

  it('is published by a later pass, before the messages behind it', async () => {
    const [first, second, third] = await waiting(3);
    publisher.failOn = second;
    await relay.pass();

    publisher.failOn = undefined;
    await relay.pass();

    expect(publisher.published).toEqual([first, second, third]);
    expect(await unpublished()).toEqual([]);
  });
});

describe('two relays at once (OBX-006)', () => {
  it('the second skips its pass while the first is inside its own', async () => {
    const ids = await waiting(2);
    let open = (): void => undefined;
    publisher.gate = new Promise((resolve) => {
      open = resolve;
    });

    const first = relay.pass();
    // the first pass holds the lock from its first statement on; give it that statement
    const second = await waitForSkip();
    open();

    expect(second).toEqual({ skipped: true, published: 0, more: false });
    expect(await first).toMatchObject({ skipped: false, published: 2 });
    expect(publisher.published).toEqual(ids);
  });

  /** Passes until one is skipped: the other relay has taken the lock by then. */
  async function waitForSkip() {
    for (;;) {
      const pass = await Promise.race([relay.pass(), gateStillClosed()]);
      if (pass?.skipped) return pass;
    }
  }

  /** A pass that got the lock itself would wait on the gate for ever: do not wait for it. */
  const gateStillClosed = (): Promise<undefined> =>
    new Promise((resolve) => setTimeout(resolve, 50, undefined));

  it('FOR UPDATE SKIP LOCKED alone: two transactions take different rows, none twice', async () => {
    const ids = await waiting(4);
    const take = `SELECT id::text FROM outbox WHERE published_at IS NULL
                   ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED`;

    const taken = await testDb().$transaction(async (one) => {
      const first = await one.$queryRawUnsafe<{ id: string }[]>(take);
      // a second connection, while the first still holds its two rows
      const second = await testDb().$transaction((two) =>
        two.$queryRawUnsafe<{ id: string }[]>(take),
      );
      return { first: first.map((r) => r.id), second: second.map((r) => r.id) };
    });

    // nobody waited, nobody took a row twice: and the second went past older, locked rows,
    // which is why the relay does not rely on this for order
    expect(taken).toEqual({ first: ids.slice(0, 2), second: ids.slice(2, 4) });
  });
});

describe('retention (OBX-009)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('deletes the messages published before the cutoff, and nothing else', async () => {
    const [old, recent, stuck] = await waiting(3);
    const now = Date.now();
    await testDb().outboxMessage.update({
      where: { id: old ?? '' },
      data: { publishedAt: new Date(now - 8 * DAY_MS) },
    });
    await testDb().outboxMessage.update({
      where: { id: recent ?? '' },
      data: { publishedAt: new Date(now - 6 * DAY_MS) },
    });
    // never published, and older than the retention: it still has to go out
    await testDb().outboxMessage.update({
      where: { id: stuck ?? '' },
      data: { createdAt: new Date(now - 30 * DAY_MS) },
    });

    const deleted = await cleanup.deletePublishedBefore(new Date(now - 7 * DAY_MS));

    expect(deleted).toBe(1);
    const left = await testDb().outboxMessage.findMany({ orderBy: { id: 'asc' } });
    expect(left.map((row) => row.id)).toEqual([recent, stuck]);
  });
});
