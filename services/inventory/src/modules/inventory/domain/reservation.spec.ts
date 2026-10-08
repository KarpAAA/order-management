import { describe, expect, it } from 'vitest';

import { ATTEMPT, LATER, NOW, PRODUCT_A, PRODUCT_B } from './__test__/builders';
import { ReservationNotHeldError } from './errors';
import { Reservation } from './reservation';
import { ReservationStatus } from './reservation-status';

const held = () =>
  Reservation.hold({ ...ATTEMPT, now: NOW, lines: [{ productId: PRODUCT_A, quantity: 2 }] });

const rejected = () =>
  Reservation.reject({
    ...ATTEMPT,
    now: NOW,
    lines: [
      { productId: PRODUCT_A, quantity: 2, available: null },
      { productId: PRODUCT_B, quantity: 5, available: 1 },
    ],
  });

describe('a reservation is born', () => {
  it('RESERVED, holding its lines', () => {
    const reservation = held();

    expect(reservation.snapshot()).toEqual({
      id: reservation.id,
      ...ATTEMPT,
      status: ReservationStatus.Reserved,
      lines: [{ productId: PRODUCT_A, quantity: 2, available: null }],
      version: 0,
      createdAt: NOW,
      releasedAt: null,
    });
    expect(reservation.holdsStock).toBe(true);
    expect(reservation.shortages).toEqual([]);
  });

  it('REJECTED, holding nothing and naming what fell short', () => {
    const reservation = rejected();

    expect(reservation.status).toBe(ReservationStatus.Rejected);
    expect(reservation.holdsStock).toBe(false);
    expect(reservation.shortages).toEqual([{ productId: PRODUCT_B, requested: 5, available: 1 }]);
    expect(reservation.snapshot().releasedAt).toBeNull();
  });

  it('RELEASED, when the release came before the reserve', () => {
    const reservation = Reservation.releaseAhead({ ...ATTEMPT, now: NOW });

    expect(reservation.snapshot()).toMatchObject({
      ...ATTEMPT,
      status: ReservationStatus.Released,
      lines: [],
      releasedAt: NOW,
    });
    expect(reservation.holdsStock).toBe(false);
  });

  it('with an id of its own', () => {
    expect(held().id).not.toBe(held().id);
  });
});

describe('release', () => {
  it('RESERVED → RELEASED, keeping the lines it held', () => {
    const reservation = held();

    reservation.release(LATER);

    expect(reservation.snapshot()).toMatchObject({
      status: ReservationStatus.Released,
      lines: [{ productId: PRODUCT_A, quantity: 2, available: null }],
      releasedAt: LATER,
    });
    expect(reservation.holdsStock).toBe(false);
  });

  it.each([
    ['RELEASED', () => Reservation.releaseAhead({ ...ATTEMPT, now: NOW })],
    ['REJECTED', rejected],
    [
      'RELEASED once already',
      () => {
        const reservation = held();
        reservation.release(NOW);
        return reservation;
      },
    ],
  ])('is refused when %s: there is nothing to give back', (_status, build) => {
    const reservation = build();
    const before = reservation.snapshot();

    expect(() => {
      reservation.release(LATER);
    }).toThrow(ReservationNotHeldError);
    expect(reservation.snapshot()).toEqual(before);
  });
});

describe('snapshot', () => {
  it('is a copy: changing it does not change the reservation', () => {
    const reservation = held();

    (reservation.snapshot().lines[0] as { quantity: number }).quantity = 99;

    expect(reservation.lines[0]?.quantity).toBe(2);
  });
});
