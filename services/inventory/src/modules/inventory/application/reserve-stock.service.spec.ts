import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@shared/errors/forbidden-error';

import {
  ATTEMPT,
  LATER,
  NOW,
  ORDER_ID,
  PRODUCT_A,
  PRODUCT_B,
  stockItem,
} from '../domain/__test__/builders';
import {
  ReservationAlreadyExistsError,
  ReservationOfAnotherWorkspaceError,
} from '../domain/errors';
import { Reservation } from '../domain/reservation';
import { ReservationStatus } from '../domain/reservation-status';

import {
  consumer,
  CORRELATION_ID,
  enableNoOpTransactions,
  fixedClock,
  stranger,
} from './__test__/fixtures';
import { InMemoryReservationsRepository } from './__test__/in-memory-reservations.repository';
import { InMemoryStockRepository } from './__test__/in-memory-stock.repository';
import { RecordingEventsPublisher } from './__test__/recording-events-publisher';
import { InventoryPolicy } from './inventory.policy';
import { ReserveStockService } from './reserve-stock.service';

import type { Journal } from './__test__/fixtures';
import type { ReserveStockCommand } from './inventory-commands';

const command = (overrides: Partial<ReserveStockCommand> = {}): ReserveStockCommand => ({
  ...ATTEMPT,
  correlationId: CORRELATION_ID,
  lines: [
    { productId: PRODUCT_B, quantity: 1 },
    { productId: PRODUCT_A, quantity: 2 },
  ],
  ...overrides,
});

describe('ReserveStockService', () => {
  let journal: Journal;
  let stock: InMemoryStockRepository;
  let reservations: InMemoryReservationsRepository;
  let publisher: RecordingEventsPublisher;

  beforeAll(enableNoOpTransactions);

  beforeEach(() => {
    journal = [];
    stock = new InMemoryStockRepository(journal);
    reservations = new InMemoryReservationsRepository(journal);
    publisher = new RecordingEventsPublisher(journal);
    stock.put(
      stockItem({ productId: PRODUCT_A, onHand: 5 }),
      stockItem({ productId: PRODUCT_B, onHand: 1 }),
    );
  });

  const reserveStock = (): ReserveStockService =>
    new ReserveStockService(stock, reservations, new InventoryPolicy(), fixedClock, publisher);

  it('holds every line, records the reservation and answers that it is held', async () => {
    await reserveStock().execute(command(), consumer);

    expect([stock.get(PRODUCT_A)?.reserved, stock.get(PRODUCT_B)?.reserved]).toEqual([2, 1]);
    expect(reservations.all().map((reservation) => reservation.snapshot())).toEqual([
      expect.objectContaining({
        ...ATTEMPT,
        status: ReservationStatus.Reserved,
        createdAt: LATER,
        lines: [
          { productId: PRODUCT_B, quantity: 1, available: null },
          { productId: PRODUCT_A, quantity: 2, available: null },
        ],
      }),
    ]);
    expect(publisher.answers).toEqual([
      { answer: 'reservation', status: ReservationStatus.Reserved, orderId: ORDER_ID, attempt: 1 },
    ]);
    expect(publisher.correlationIds).toEqual([CORRELATION_ID]);
  });

  it('locks the stock before it reads anything, and answers last', async () => {
    await reserveStock().execute(command(), consumer);

    expect(journal).toEqual([
      `lock stock ${PRODUCT_A},${PRODUCT_B}`,
      'find reservation',
      'save stock',
      'insert reservation',
      'answer',
    ]);
  });

  it('locks a product asked on two lines once', async () => {
    const line = { productId: PRODUCT_A, quantity: 1 };

    await reserveStock().execute(command({ lines: [line, line] }), consumer);

    expect(journal[0]).toBe(`lock stock ${PRODUCT_A}`);
    expect(stock.get(PRODUCT_A)?.reserved).toBe(2);
  });

  it('holds nothing when a line falls short, and answers with a rejection', async () => {
    const lines = [
      { productId: PRODUCT_A, quantity: 2 },
      { productId: PRODUCT_B, quantity: 2 },
    ];

    await reserveStock().execute(command({ lines }), consumer);

    expect([stock.get(PRODUCT_A)?.reserved, stock.get(PRODUCT_B)?.reserved]).toEqual([0, 0]);
    expect(reservations.all()[0]?.shortages).toEqual([
      { productId: PRODUCT_B, requested: 2, available: 1 },
    ]);
    expect(publisher.answers).toEqual([
      { answer: 'reservation', status: ReservationStatus.Rejected, orderId: ORDER_ID, attempt: 1 },
    ]);
    // a rejection writes no stock: nothing was held
    expect(journal).not.toContain('save stock');
  });

  it('rejects a product the service has never heard of', async () => {
    const unknown = '01990000-0000-7000-8000-a10000000099';

    await reserveStock().execute(
      command({ lines: [{ productId: unknown, quantity: 1 }] }),
      consumer,
    );

    expect(reservations.all()[0]?.shortages).toEqual([
      { productId: unknown, requested: 1, available: 0 },
    ]);
  });

  it('asked again for an attempt it has settled, changes nothing and answers the same', async () => {
    await reserveStock().execute(command(), consumer);
    journal.length = 0;

    await reserveStock().execute(command({ correlationId: 'again' }), consumer);

    expect(stock.get(PRODUCT_A)?.reserved).toBe(2);
    expect(reservations.all()).toHaveLength(1);
    expect(journal).toEqual([`lock stock ${PRODUCT_A},${PRODUCT_B}`, 'find reservation', 'answer']);
    expect(publisher.answers[1]).toEqual(publisher.answers[0]);
    // the answer belongs to the command that is answered now
    expect(publisher.correlationIds).toEqual([CORRELATION_ID, 'again']);
  });

  it('does not revive a rejected attempt when stock has arrived since', async () => {
    await reserveStock().execute(
      command({ lines: [{ productId: PRODUCT_B, quantity: 2 }] }),
      consumer,
    );
    stock.put(stockItem({ productId: PRODUCT_B, onHand: 10 }));

    await reserveStock().execute(
      command({ lines: [{ productId: PRODUCT_B, quantity: 2 }] }),
      consumer,
    );

    expect(stock.get(PRODUCT_B)?.reserved).toBe(0);
    expect(publisher.answers[1]).toMatchObject({ status: ReservationStatus.Rejected });
  });

  it('holds nothing for an attempt that was released before it was asked for', async () => {
    reservations.put(Reservation.releaseAhead({ ...ATTEMPT, now: NOW }));

    await reserveStock().execute(command(), consumer);

    expect([stock.get(PRODUCT_A)?.reserved, stock.get(PRODUCT_B)?.reserved]).toEqual([0, 0]);
    expect(publisher.answers).toEqual([
      { answer: 'reservation', status: ReservationStatus.Released, orderId: ORDER_ID, attempt: 1 },
    ]);
  });

  it('holds stock again for the next attempt of the same order', async () => {
    await reserveStock().execute(command(), consumer);

    await reserveStock().execute(
      command({ attempt: 2, lines: [{ productId: PRODUCT_A, quantity: 3 }] }),
      consumer,
    );

    expect(stock.get(PRODUCT_A)?.reserved).toBe(5);
    expect(reservations.all().map((reservation) => reservation.attempt)).toEqual([1, 2]);
  });

  it('leaves the refusal of a second writer of the same attempt to the caller', async () => {
    const racing = reserveStock();
    // another delivery writes the attempt after this one has looked for it
    const findByAttempt = reservations.findByAttempt.bind(reservations);
    reservations.findByAttempt = async (key) => {
      const found = await findByAttempt(key);
      reservations.put(Reservation.releaseAhead({ ...ATTEMPT, now: NOW }));
      return found;
    };

    await expect(racing.execute(command(), consumer)).rejects.toThrow(
      ReservationAlreadyExistsError,
    );
    expect(publisher.answers).toEqual([]);
  });

  it('refuses an attempt that belongs to another workspace', async () => {
    await reserveStock().execute(command(), consumer);

    const other = command({ workspaceId: '01990000-0000-7000-8000-b00000000000' });

    await expect(reserveStock().execute(other, consumer)).rejects.toThrow(
      ReservationOfAnotherWorkspaceError,
    );
  });

  it('sees only the stock of the workspace of the command', async () => {
    const other = command({
      workspaceId: '01990000-0000-7000-8000-b00000000000',
      orderId: '01990000-0000-7000-8000-0d0000000002',
    });

    await reserveStock().execute(other, consumer);

    expect(publisher.answers[0]).toMatchObject({ status: ReservationStatus.Rejected });
    expect(stock.get(PRODUCT_A)?.reserved).toBe(0);
  });

  it('is for the consumer of the service only, and touches nothing before it knows', async () => {
    await expect(reserveStock().execute(command(), stranger)).rejects.toThrow(ForbiddenError);
    expect(journal).toEqual([]);
  });
});
