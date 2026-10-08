// The service to its boundary: a command goes in through RabbitMQ, and what comes out is the
// stock and the reservations in the service's own database and one event on the `events`
// exchange. The api is not here: the test is the other side of the broker
// (test/helpers/broker.ts). Every assertion is on an outcome (rows, events), never on "a
// method was called". Commands that meet at the same moment: concurrency.e2e-spec.ts.
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestBroker, type TestBroker } from '../helpers/broker';
import {
  adjustCommand,
  COMMANDS_QUEUE,
  DEAD_LETTER_QUEUE,
  givenStock,
  levelsOf,
  OTHER_WORKSPACE,
  releaseCommand,
  reservationsOf,
  reserveCommand,
  WORKSPACE,
} from '../helpers/commands';
import { failInsertsInto } from '../helpers/failing-inserts';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

let broker: TestBroker;
let service: WorkerApp;

beforeAll(async () => {
  // first: its queue must be bound before the service publishes anything
  broker = await connectTestBroker();
  service = await createWorkerApp();
});
afterAll(async () => {
  try {
    await service.close();
  } finally {
    await broker.close();
  }
});

/**
 * Proof that every command sent before this call has been handled: the service takes one
 * message at a time (RABBITMQ_PREFETCH=1), so a command sent after them is behind them in
 * the queue, and its answer comes after theirs.
 */
async function handled(): Promise<void> {
  const marker = uuidv7();
  await broker.send(adjustCommand({ productId: marker, delta: 1 }));
  await broker.waitForEvents(marker, 1);
}

const parked = async () =>
  (await broker.take(DEAD_LETTER_QUEUE)).map(({ content, headers }) => ({
    message: JSON.parse(content.toString()) as { messageId: string },
    error: String(headers['x-last-error']),
  }));

const namesOf = (subjectId: string) => broker.events(subjectId).map((event) => event.name);

describe('inventory.adjust-stock', () => {
  it('INV-001 opens the stock of a product it hears of for the first time', async () => {
    const productId = uuidv7();
    const command = adjustCommand({ productId, delta: 50 });

    await broker.send(command);
    const [event] = await broker.waitForEvents(productId);

    expect(event).toMatchObject({
      name: 'inventory.stock-adjusted',
      workspaceId: WORKSPACE,
      correlationId: command.correlationId,
      payload: { productId, onHand: 50, reserved: 0 },
    });
    expect(await levelsOf(productId)).toEqual({ onHand: 50, reserved: 0 });
  });

  it('INV-002 adds a difference to what the stock is, in either direction', async () => {
    const productId = await givenStock(10);

    await broker.send(adjustCommand({ productId, delta: 5 }));
    await broker.send(adjustCommand({ productId, delta: -12 }));
    const events = await broker.waitForEvents(productId, 2);

    expect(events.map((event) => event.payload)).toEqual([
      { productId, onHand: 15, reserved: 0 },
      { productId, onHand: 3, reserved: 0 },
    ]);
    expect(await levelsOf(productId)).toEqual({ onHand: 3, reserved: 0 });
  });

  it('INV-003 parks a command that would take away what reservations hold', async () => {
    const productId = await givenStock(10);
    const orderId = uuidv7();
    await broker.send(reserveCommand({ orderId, lines: [{ productId, quantity: 4 }] }));
    await broker.waitForEvents(orderId);
    const command = adjustCommand({ productId, delta: -7 });

    await broker.send(command);
    await handled();

    expect(await parked()).toEqual([
      {
        message: expect.objectContaining({ messageId: command.messageId }),
        error: expect.stringContaining('STOCK_BELOW_RESERVED'),
      },
    ]);
    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 4 });
    expect(broker.events(productId)).toEqual([]);
  });

  it('INV-004 counts the same message once: nothing but the inbox says it came before', async () => {
    const productId = await givenStock(0);
    const command = adjustCommand({ productId, delta: 5 });

    await broker.send(command);
    await broker.send(command);
    await handled();

    expect(await levelsOf(productId)).toEqual({ onHand: 5, reserved: 0 });
    expect(namesOf(productId)).toEqual(['inventory.stock-adjusted']);
  });
});

describe('inventory.reserve-stock', () => {
  it('INV-010 holds every line and answers inventory.stock-reserved', async () => {
    const [a, b] = [await givenStock(10), await givenStock(3)];
    const orderId = uuidv7();
    const command = reserveCommand({
      orderId,
      lines: [
        { productId: a, quantity: 4 },
        { productId: b, quantity: 3 },
      ],
    });

    await broker.send(command);
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'inventory.stock-reserved',
      workspaceId: WORKSPACE,
      correlationId: command.correlationId,
      payload: { orderId, attempt: 1 },
    });
    expect([await levelsOf(a), await levelsOf(b)]).toEqual([
      { onHand: 10, reserved: 4 },
      { onHand: 3, reserved: 3 },
    ]);
    expect(await reservationsOf(orderId)).toEqual([
      {
        attempt: 1,
        status: 'RESERVED',
        version: 0,
        lines: expect.arrayContaining([
          { productId: a, quantity: 4, available: null },
          { productId: b, quantity: 3, available: null },
        ]),
      },
    ]);
  });

  it('INV-011 holds nothing when one line falls short, and says which and by how much', async () => {
    const [a, b] = [await givenStock(10), await givenStock(1)];
    const orderId = uuidv7();

    await broker.send(
      reserveCommand({
        orderId,
        lines: [
          { productId: a, quantity: 4 },
          { productId: b, quantity: 2 },
        ],
      }),
    );
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'inventory.stock-reservation-failed',
      payload: {
        orderId,
        attempt: 1,
        reason: 'insufficient_stock',
        shortages: [{ productId: b, requested: 2, available: 1 }],
      },
    });
    expect([await levelsOf(a), await levelsOf(b)]).toEqual([
      { onHand: 10, reserved: 0 },
      { onHand: 1, reserved: 0 },
    ]);
    expect(await reservationsOf(orderId)).toMatchObject([{ attempt: 1, status: 'REJECTED' }]);
  });

  it('INV-012 rejects a product that has no stock at all', async () => {
    const productId = uuidv7();
    const orderId = uuidv7();

    await broker.send(reserveCommand({ orderId, lines: [{ productId, quantity: 1 }] }));
    const [event] = await broker.waitForEvents(orderId);

    expect(event?.payload).toMatchObject({
      shortages: [{ productId, requested: 1, available: 0 }],
    });
    expect(await levelsOf(productId)).toBeNull();
  });

  it('INV-013 adds up a product asked on two lines', async () => {
    const productId = await givenStock(3);
    const orderId = uuidv7();
    const line = { productId, quantity: 2 };

    await broker.send(reserveCommand({ orderId, lines: [line, line] }));
    const [event] = await broker.waitForEvents(orderId);

    expect(event?.payload).toMatchObject({
      shortages: [{ productId, requested: 4, available: 3 }],
    });
  });

  it('INV-014 handles the same message once: one reservation, one answer', async () => {
    const productId = await givenStock(10);
    const orderId = uuidv7();
    const command = reserveCommand({ orderId, lines: [{ productId, quantity: 2 }] });

    await broker.send(command);
    await broker.send(command);
    await handled();

    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 2 });
    expect(namesOf(orderId)).toEqual(['inventory.stock-reserved']);
  });

  it('INV-015 asked again by another message, holds once and answers again', async () => {
    const productId = await givenStock(10);
    const orderId = uuidv7();
    const lines = [{ productId, quantity: 2 }];

    await broker.send(reserveCommand({ orderId, lines }));
    await broker.send(reserveCommand({ orderId, lines }));
    await broker.waitForEvents(orderId, 2);

    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 2 });
    expect(await reservationsOf(orderId)).toHaveLength(1);
    expect(namesOf(orderId)).toEqual(['inventory.stock-reserved', 'inventory.stock-reserved']);
  });

  it('INV-016 does not revive a rejected attempt when stock arrives; the next attempt holds', async () => {
    const productId = await givenStock(1);
    const orderId = uuidv7();
    const lines = [{ productId, quantity: 2 }];
    await broker.send(reserveCommand({ orderId, lines }));
    await broker.waitForEvents(orderId, 1);
    await broker.send(adjustCommand({ productId, delta: 5 }));

    await broker.send(reserveCommand({ orderId, lines }));
    await broker.send(reserveCommand({ orderId, attempt: 2, lines }));
    await broker.waitForEvents(orderId, 3);

    expect(namesOf(orderId)).toEqual([
      'inventory.stock-reservation-failed',
      'inventory.stock-reservation-failed',
      'inventory.stock-reserved',
    ]);
    expect(await levelsOf(productId)).toEqual({ onHand: 6, reserved: 2 });
    expect(await reservationsOf(orderId)).toMatchObject([
      { attempt: 1, status: 'REJECTED' },
      { attempt: 2, status: 'RESERVED' },
    ]);
  });
});

describe('inventory.release-stock', () => {
  it('INV-020 gives back what the attempt holds and answers inventory.stock-released', async () => {
    const [a, b] = [await givenStock(10), await givenStock(3)];
    const [orderId, otherOrder] = [uuidv7(), uuidv7()];
    const lines = [
      { productId: a, quantity: 4 },
      { productId: b, quantity: 1 },
    ];
    await broker.send(reserveCommand({ orderId, lines }));
    await broker.send(reserveCommand({ orderId: otherOrder, lines }));
    await broker.waitForEvents(otherOrder);
    const command = releaseCommand({ orderId });

    await broker.send(command);
    const events = await broker.waitForEvents(orderId, 2);

    expect(events[1]).toMatchObject({
      name: 'inventory.stock-released',
      correlationId: command.correlationId,
      payload: { orderId, attempt: 1 },
    });
    // what the other order holds stays held
    expect([await levelsOf(a), await levelsOf(b)]).toEqual([
      { onHand: 10, reserved: 4 },
      { onHand: 3, reserved: 1 },
    ]);
    expect(await reservationsOf(orderId)).toMatchObject([{ status: 'RELEASED', version: 1 }]);
    expect(await reservationsOf(otherOrder)).toMatchObject([{ status: 'RESERVED', version: 0 }]);
  });

  it('INV-021 released twice by two messages, gives back once and answers twice', async () => {
    const productId = await givenStock(10);
    const orderId = uuidv7();
    await broker.send(reserveCommand({ orderId, lines: [{ productId, quantity: 4 }] }));

    await broker.send(releaseCommand({ orderId }));
    await broker.send(releaseCommand({ orderId }));
    await broker.waitForEvents(orderId, 3);

    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 0 });
    expect(namesOf(orderId)).toEqual([
      'inventory.stock-reserved',
      'inventory.stock-released',
      'inventory.stock-released',
    ]);
  });

  it('INV-022 a release that comes before its reserve leaves that reserve holding nothing', async () => {
    const productId = await givenStock(10);
    const orderId = uuidv7();

    await broker.send(releaseCommand({ orderId }));
    await broker.send(reserveCommand({ orderId, lines: [{ productId, quantity: 4 }] }));
    await broker.waitForEvents(orderId, 2);

    expect(namesOf(orderId)).toEqual(['inventory.stock-released', 'inventory.stock-released']);
    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 0 });
    expect(await reservationsOf(orderId)).toEqual([
      { attempt: 1, status: 'RELEASED', version: 0, lines: [] },
    ]);
  });

  it('INV-023 the release of a rejected attempt changes nothing and is answered', async () => {
    const productId = await givenStock(1);
    const orderId = uuidv7();
    await broker.send(reserveCommand({ orderId, lines: [{ productId, quantity: 2 }] }));

    await broker.send(releaseCommand({ orderId }));
    await broker.waitForEvents(orderId, 2);

    expect(namesOf(orderId)).toEqual([
      'inventory.stock-reservation-failed',
      'inventory.stock-released',
    ]);
    expect(await reservationsOf(orderId)).toMatchObject([{ status: 'REJECTED', version: 0 }]);
  });

  it('INV-024 an order placed again holds stock again: one reservation per attempt', async () => {
    const productId = await givenStock(5);
    const orderId = uuidv7();
    const lines = [{ productId, quantity: 5 }];

    await broker.send(reserveCommand({ orderId, lines }));
    await broker.send(releaseCommand({ orderId }));
    await broker.send(reserveCommand({ orderId, attempt: 2, lines }));
    await broker.waitForEvents(orderId, 3);

    expect(namesOf(orderId)).toEqual([
      'inventory.stock-reserved',
      'inventory.stock-released',
      'inventory.stock-reserved',
    ]);
    expect(await levelsOf(productId)).toEqual({ onHand: 5, reserved: 5 });
    expect(await reservationsOf(orderId)).toMatchObject([
      { attempt: 1, status: 'RELEASED' },
      { attempt: 2, status: 'RESERVED' },
    ]);
  });
});

describe('the tenant comes from the envelope', () => {
  it('INV-030 stock of another workspace is not there to be held', async () => {
    const productId = await givenStock(10, OTHER_WORKSPACE);
    const orderId = uuidv7();

    await broker.send(reserveCommand({ orderId, lines: [{ productId, quantity: 1 }] }));
    const [event] = await broker.waitForEvents(orderId);

    expect(event).toMatchObject({
      name: 'inventory.stock-reservation-failed',
      workspaceId: WORKSPACE,
      payload: { shortages: [{ productId, requested: 1, available: 0 }] },
    });
    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 0 });
  });

  it('INV-031 a command for an attempt of another workspace is parked, and changes nothing', async () => {
    const productId = await givenStock(10);
    const orderId = uuidv7();
    await broker.send(reserveCommand({ orderId, lines: [{ productId, quantity: 4 }] }));
    await broker.waitForEvents(orderId);
    const command = releaseCommand({ orderId, workspaceId: OTHER_WORKSPACE });

    await broker.send(command);
    await handled();

    expect(await parked()).toEqual([
      {
        message: expect.objectContaining({ messageId: command.messageId }),
        error: expect.stringContaining('RESERVATION_OF_ANOTHER_WORKSPACE'),
      },
    ]);
    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 4 });
  });
});

describe('a command and what it causes are one transaction', () => {
  const recorded = (messageId: string) => testDb().inboxMessage.count({ where: { messageId } });

  it('INV-040 the stock, the reservation, the answer and the record of the message commit together', async () => {
    const productId = await givenStock(10);
    const orderId = uuidv7();
    const command = reserveCommand({ orderId, lines: [{ productId, quantity: 4 }] });

    await broker.send(command);
    const [event] = await broker.waitForEvents(orderId);

    expect(await recorded(command.messageId)).toBe(1);
    expect(await testDb().outboxMessage.count({ where: { id: event?.messageId ?? '' } })).toBe(1);
  });

  it('INV-041 an answer that cannot be written leaves no stock held and no record of the message', async () => {
    const productId = await givenStock(10);
    const orderId = uuidv7();
    const command = reserveCommand({ orderId, lines: [{ productId, quantity: 4 }] });
    const restore = await failInsertsInto('outbox');
    let dead: Awaited<ReturnType<TestBroker['take']>>;
    try {
      await broker.send(command);
      // every delivery fails on the outbox row; after the last one the command is parked
      dead = await waitFor(
        () => broker.take(DEAD_LETTER_QUEUE),
        (taken) => taken.length > 0,
        { what: 'the command in the dead-letter queue' },
      );
    } finally {
      await restore();
    }

    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 0 });
    expect(await reservationsOf(orderId)).toEqual([]);
    expect(await recorded(command.messageId)).toBe(0);
    expect(broker.events(orderId)).toEqual([]);

    // put back by an operator, it is a message the service has never handled
    broker.put(COMMANDS_QUEUE, dead[0]!.content);
    await broker.waitForEvents(orderId);

    expect(namesOf(orderId)).toEqual(['inventory.stock-reserved']);
    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 4 });
  });
});

describe('a message that cannot be processed', () => {
  const valid = reserveCommand({
    orderId: uuidv7(),
    lines: [{ productId: uuidv7(), quantity: 1 }],
  });
  const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

  it.each([
    ['not JSON', Buffer.from('not json')],
    ['a contract this build does not know', json({ ...valid, name: 'inventory.count-stock' })],
    ['a version this build does not know', json({ ...valid, version: 2 })],
    ['a reserve with no lines', json({ ...valid, payload: { ...valid.payload, lines: [] } })],
    [
      'an event of the service sent back as a command',
      json({ ...valid, name: 'inventory.stock-reserved' }),
    ],
  ])(
    'INV-050 %s is parked on its first delivery, and the next command is served',
    async (_case, content) => {
      broker.sendRaw('inventory.reserve-stock', content);
      await handled();

      const dead = await broker.take(DEAD_LETTER_QUEUE);
      expect(dead.map((message) => message.content.toString())).toEqual([content.toString()]);
      expect(await reservationsOf(valid.payload.orderId)).toEqual([]);
    },
  );
});
