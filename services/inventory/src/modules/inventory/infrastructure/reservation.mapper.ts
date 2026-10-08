import type { Prisma } from '@infra/database/generated/prisma/client';

import { Reservation } from '../domain/reservation';

import type { ReservationStatus } from '../domain/reservation-status';

export const reservationWithLinesInclude = {
  lines: {
    select: { productId: true, quantity: true, available: true },
    orderBy: { productId: 'asc' },
  },
} satisfies Prisma.ReservationInclude;

type ReservationRowWithLines = Prisma.ReservationGetPayload<{
  include: typeof reservationWithLinesInclude;
}>;

export const ReservationMapper = {
  toDomain(row: ReservationRowWithLines): Reservation {
    return Reservation.restore({
      id: row.id,
      workspaceId: row.workspaceId,
      orderId: row.orderId,
      attempt: row.attempt,
      status: row.status as ReservationStatus,
      lines: row.lines,
      version: row.version,
      createdAt: row.createdAt,
      releasedAt: row.releasedAt,
    });
  },

  toCreate(reservation: Reservation): Prisma.ReservationUncheckedCreateInput {
    const s = reservation.snapshot();
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      orderId: s.orderId,
      attempt: s.attempt,
      status: s.status,
      createdAt: s.createdAt,
      releasedAt: s.releasedAt,
      lines: { createMany: { data: s.lines } },
    };
  },

  /** What a release changes: the lines are written once, with the reservation. */
  toUpdate(reservation: Reservation): Prisma.ReservationUncheckedUpdateInput {
    const { status, releasedAt } = reservation.snapshot();
    return { status, releasedAt };
  },
};
