import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConcurrencyError } from '@shared/errors/domain-error';
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
import { ReservationOfAnotherWorkspaceError } from '../domain/errors';
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
import { ReleaseStockService } from './release-stock.service';

import type { Journal } from './__test__/fixtures';
import type { ReleaseStockCommand } from './inventory-commands';

const command = (overrides: Partial<ReleaseStockCommand> = {}): ReleaseStockCommand => ({
  ...ATTEMPT,
  correlationId: CORRELATION_ID,
  ...overrides,
});

const RELEASED = { answer: 'released', orderId: ORDER_ID, attempt: 1 };

describe('ReleaseStockService', () => {
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
  });

  const releaseStock = (): ReleaseStockService =>
    new ReleaseStockService(stock, reservations, new InventoryPolicy(), fixedClock, publisher);

  /** An attempt that holds 2 of A and 1 of B, out of stock that others hold too. */
  const heldReservation = (): void => {
    stock.put(
      stockItem({ productId: PRODUCT_A, onHand: 5, reserved: 4 }),
      stockItem({ productId: PRODUCT_B, onHand: 1, reserved: 1 }),
    );
    reservations.put(
      Reservation.hold({
        ...ATTEMPT,
        now: NOW,
        lines: [
          { productId: PRODUCT_B, quantity: 1 },
          { productId: PRODUCT_A, quantity: 2 },
        ],
      }),
    );
  };

  it('gives the lines of a held reservation back and answers that nothing is held', async () => {
    heldReservation();

    await releaseStock().execute(command(), consumer);

    expect([stock.get(PRODUCT_A)?.reserved, stock.get(PRODUCT_B)?.reserved]).toEqual([2, 0]);
    expect(reservations.all()[0]?.snapshot()).toMatchObject({
      status: ReservationStatus.Released,
      releasedAt: LATER,
      version: 1,
    });
    expect(publisher.answers).toEqual([RELEASED]);
    expect(publisher.correlationIds).toEqual([CORRELATION_ID]);
  });

  it('saves the reservation before it touches the stock', async () => {
    heldReservation();

    await releaseStock().execute(command(), consumer);

    expect(journal).toEqual([
      'find reservation',
      'save reservation',
      `lock stock ${PRODUCT_A},${PRODUCT_B}`,
      'save stock',
      'answer',
    ]);
  });

  it('gives nothing back when another release saved the reservation first', async () => {
    heldReservation();
    const first = releaseStock();
    // both deliveries read RESERVED; the other one saves before this one does
    const save = reservations.save.bind(reservations);
    let raced = false;
    reservations.save = async (reservation) => {
      if (!raced) {
        raced = true;
        await releaseStock().execute(command(), consumer);
      }
      return save(reservation);
    };

    await expect(first.execute(command(), consumer)).rejects.toThrow(ConcurrencyError);

    // given back once, by the release that won
    expect([stock.get(PRODUCT_A)?.reserved, stock.get(PRODUCT_B)?.reserved]).toEqual([2, 0]);
    expect(publisher.answers).toEqual([RELEASED]);
  });

  it('asked again for a released attempt, changes nothing and answers the same', async () => {
    heldReservation();
    await releaseStock().execute(command(), consumer);
    journal.length = 0;

    await releaseStock().execute(command(), consumer);

    expect([stock.get(PRODUCT_A)?.reserved, stock.get(PRODUCT_B)?.reserved]).toEqual([2, 0]);
    expect(journal).toEqual(['find reservation', 'answer']);
    expect(publisher.answers).toEqual([RELEASED, RELEASED]);
  });

  it('answers the release of a rejected attempt without touching it', async () => {
    reservations.put(
      Reservation.reject({
        ...ATTEMPT,
        now: NOW,
        lines: [{ productId: PRODUCT_A, quantity: 2, available: 0 }],
      }),
    );

    await releaseStock().execute(command(), consumer);

    expect(reservations.all()[0]?.status).toBe(ReservationStatus.Rejected);
    expect(journal).toEqual(['find reservation', 'answer']);
    expect(publisher.answers).toEqual([RELEASED]);
  });

  it('records an attempt it has never heard of as released: the reserve is still on its way', async () => {
    await releaseStock().execute(command(), consumer);

    expect(reservations.all().map((reservation) => reservation.snapshot())).toEqual([
      expect.objectContaining({
        ...ATTEMPT,
        status: ReservationStatus.Released,
        lines: [],
        releasedAt: LATER,
      }),
    ]);
    expect(journal).toEqual(['find reservation', 'insert reservation', 'answer']);
    expect(publisher.answers).toEqual([RELEASED]);
  });

  it('releases one attempt of an order and leaves the other', async () => {
    heldReservation();
    reservations.put(
      Reservation.hold({
        ...ATTEMPT,
        attempt: 2,
        now: NOW,
        lines: [{ productId: PRODUCT_A, quantity: 2 }],
      }),
    );

    await releaseStock().execute(command({ attempt: 2 }), consumer);

    expect(stock.get(PRODUCT_A)?.reserved).toBe(2);
    expect(reservations.all().map((reservation) => reservation.status)).toEqual([
      ReservationStatus.Reserved,
      ReservationStatus.Released,
    ]);
  });

  it('refuses an attempt that belongs to another workspace', async () => {
    heldReservation();
    const other = command({ workspaceId: '01990000-0000-7000-8000-b00000000000' });

    await expect(releaseStock().execute(other, consumer)).rejects.toThrow(
      ReservationOfAnotherWorkspaceError,
    );
    expect(stock.get(PRODUCT_A)?.reserved).toBe(4);
  });

  it('is for the consumer of the service only, and touches nothing before it knows', async () => {
    await expect(releaseStock().execute(command(), stranger)).rejects.toThrow(ForbiddenError);
    expect(journal).toEqual([]);
  });
});
