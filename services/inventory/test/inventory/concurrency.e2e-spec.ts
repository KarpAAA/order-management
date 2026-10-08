// Commands that meet at the same moment (ROADMAP 3.6: who gets the last unit, and why).
// One process takes one command at a time (RABBITMQ_PREFETCH=1), so the suite starts several:
// each has its own channel and its own database connections, as replicas of the service do.
// What is asserted is what must hold whatever the interleaving was: the levels of the stock,
// the reservations, the answers, and that the database never had to break a deadlock.
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestBroker, type TestBroker } from '../helpers/broker';
import {
  adjustCommand,
  DEAD_LETTER_QUEUE,
  givenStock,
  levelsOf,
  releaseCommand,
  reservationsOf,
  reserveCommand,
} from '../helpers/commands';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

const REPLICAS = 4;

let broker: TestBroker;
let services: WorkerApp[];

beforeAll(async () => {
  // first: its queue must be bound before the service publishes anything
  broker = await connectTestBroker();
  services = await Promise.all(Array.from({ length: REPLICAS }, () => createWorkerApp()));
});
afterAll(async () => {
  try {
    await Promise.all(services.map((service) => service.close()));
  } finally {
    await broker.close();
  }
});

const orders = (count: number): string[] => Array.from({ length: count }, () => uuidv7());

/** Sends everything at once: the replicas take the commands in whatever order they come. */
async function sendAll(commands: { name: string }[]): Promise<void> {
  await Promise.all(commands.map((command) => broker.send(command)));
}

/** The answers to the reserve of each order, by name. */
async function answersOf(orderIds: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const orderId of orderIds) {
    const [event] = await broker.waitForEvents(orderId);
    const name = event?.name ?? 'none';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** Deadlocks the database had to break in the database of this test file, so far. */
async function deadlocks(): Promise<number> {
  const [row] = await testDb().$queryRaw<{ deadlocks: bigint }[]>`
    SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
  return Number(row?.deadlocks ?? 0);
}

describe('the last unit', () => {
  it('INV-060 goes to one of 20 orders that ask for it at once; the others are told there is none', async () => {
    const productId = await givenStock(1);
    const orderIds = orders(20);

    await sendAll(
      orderIds.map((orderId) => reserveCommand({ orderId, lines: [{ productId, quantity: 1 }] })),
    );

    expect(await answersOf(orderIds)).toEqual({
      'inventory.stock-reserved': 1,
      'inventory.stock-reservation-failed': 19,
    });
    expect(await levelsOf(productId)).toEqual({ onHand: 1, reserved: 1 });
  });

  it('INV-061 5 units go to 5 of 20 orders: what is held is what the held reservations say', async () => {
    const productId = await givenStock(5);
    const orderIds = orders(20);

    await sendAll(
      orderIds.map((orderId) => reserveCommand({ orderId, lines: [{ productId, quantity: 1 }] })),
    );

    expect(await answersOf(orderIds)).toEqual({
      'inventory.stock-reserved': 5,
      'inventory.stock-reservation-failed': 15,
    });
    expect(await levelsOf(productId)).toEqual({ onHand: 5, reserved: 5 });
    const held = await testDb().reservationLine.aggregate({
      where: { productId, reservation: { status: 'RESERVED' } },
      _sum: { quantity: true },
    });
    expect(held._sum.quantity).toBe(5);
  });
});

describe('orders that want the same products in a different order', () => {
  it('INV-062 are all served, and the database breaks no deadlock', async () => {
    const [x, y] = [await givenStock(100), await givenStock(100)];
    const orderIds = orders(40);
    const before = await deadlocks();

    await sendAll(
      orderIds.map((orderId, i) => {
        const lines = [
          { productId: x, quantity: 1 },
          { productId: y, quantity: 1 },
        ];
        // every second order names the products the other way round
        return reserveCommand({ orderId, lines: i % 2 === 0 ? lines : lines.reverse() });
      }),
    );

    expect(await answersOf(orderIds)).toEqual({ 'inventory.stock-reserved': 40 });
    expect([await levelsOf(x), await levelsOf(y)]).toEqual([
      { onHand: 100, reserved: 40 },
      { onHand: 100, reserved: 40 },
    ]);
    expect(await deadlocks()).toBe(before);
  });
});

describe('two releases of one reservation at once', () => {
  it('INV-063 give the stock back once, and both are answered', async () => {
    const productId = await givenStock(10);
    const orderIds = orders(10);
    await sendAll(
      orderIds.map((orderId) => reserveCommand({ orderId, lines: [{ productId, quantity: 1 }] })),
    );
    await answersOf(orderIds);

    // two messages per reservation: the inbox does not know the second one
    await sendAll(
      orderIds.flatMap((orderId) => [releaseCommand({ orderId }), releaseCommand({ orderId })]),
    );
    for (const orderId of orderIds) await broker.waitForEvents(orderId, 3);

    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 0 });
    for (const orderId of orderIds) {
      // version 1: the reservation was saved once, by the release that won
      expect(await reservationsOf(orderId)).toMatchObject([{ status: 'RELEASED', version: 1 }]);
      expect(broker.events(orderId).map((event) => event.name)).toEqual([
        'inventory.stock-reserved',
        'inventory.stock-released',
        'inventory.stock-released',
      ]);
    }
  });
});

describe('a reserve and its release at once', () => {
  it('INV-064 end with nothing held, whichever came first', async () => {
    const productId = await givenStock(10);
    const orderIds = orders(10);

    await sendAll(
      orderIds.flatMap((orderId) => [
        reserveCommand({ orderId, lines: [{ productId, quantity: 1 }] }),
        releaseCommand({ orderId }),
      ]),
    );
    for (const orderId of orderIds) await broker.waitForEvents(orderId, 2);

    expect(await levelsOf(productId)).toEqual({ onHand: 10, reserved: 0 });
    for (const orderId of orderIds) {
      expect(await reservationsOf(orderId)).toMatchObject([{ status: 'RELEASED' }]);
    }
  });
});

describe('stock that arrives while it is being reserved', () => {
  it('INV-065 loses no unit and no reservation', async () => {
    const productId = await givenStock(0);
    const orderIds = orders(20);

    await sendAll([
      ...Array.from({ length: 10 }, () => adjustCommand({ productId, delta: 1 })),
      ...orderIds.map((orderId) =>
        reserveCommand({ orderId, lines: [{ productId, quantity: 1 }] }),
      ),
    ]);
    await broker.waitForEvents(productId, 10);
    const answers = await answersOf(orderIds);

    const levels = await levelsOf(productId);
    expect(levels?.onHand).toBe(10);
    // how many got a unit depends on who came first; what is held is what was answered
    expect(levels?.reserved).toBe(answers['inventory.stock-reserved'] ?? 0);
    expect(levels?.reserved).toBeLessThanOrEqual(10);
  });

  it('INV-066 two deliveries that open the same product both count', async () => {
    const productId = uuidv7();

    await sendAll(Array.from({ length: 8 }, () => adjustCommand({ productId, delta: 5 })));
    await broker.waitForEvents(productId, 8);

    expect(await levelsOf(productId)).toEqual({ onHand: 40, reserved: 0 });
  });
});

describe('after all of it', () => {
  it('INV-067 nothing was given up: the dead-letter queue is empty', async () => {
    expect(await broker.take(DEAD_LETTER_QUEUE)).toEqual([]);
  });
});
