import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import { isUniqueViolation } from '@infra/database/prisma-errors';
import type { DbTransactionAdapter } from '@infra/database/transactional.adapter';
import { ConcurrencyError } from '@shared/errors/domain-error';

import {
  ReservationAlreadyExistsError,
  ReservationOfAnotherWorkspaceError,
} from '../domain/errors';

import { ReservationMapper, reservationWithLinesInclude } from './reservation.mapper';

import type { Reservation } from '../domain/reservation';
import type { AttemptKey, ReservationsRepositoryPort } from '../ports/reservations-repository.port';

/**
 * Reservations by the key the commands use: the attempt of an order. Writes go through
 * `txHost.tx`, which joins the transaction of the use case.
 */
@Injectable()
export class ReservationsRepository implements ReservationsRepositoryPort {
  constructor(private readonly txHost: TransactionHost<DbTransactionAdapter>) {}

  async findByAttempt({ workspaceId, orderId, attempt }: AttemptKey): Promise<Reservation | null> {
    const row = await this.txHost.tx.reservation.findUnique({
      where: { orderId_attempt: { orderId, attempt } },
      include: reservationWithLinesInclude,
    });
    if (!row) return null;
    // the tenant is a column here: the key is unique across workspaces, the answer is not
    if (row.workspaceId !== workspaceId) {
      throw new ReservationOfAnotherWorkspaceError(orderId, attempt);
    }
    return ReservationMapper.toDomain(row);
  }

  async insert(reservation: Reservation): Promise<void> {
    try {
      await this.txHost.tx.reservation.create({ data: ReservationMapper.toCreate(reservation) });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ReservationAlreadyExistsError(reservation.orderId, reservation.attempt);
      }
      throw err;
    }
  }

  /** Optimistic lock: only the version we loaded may be overwritten. */
  async save(reservation: Reservation): Promise<void> {
    const { count } = await this.txHost.tx.reservation.updateMany({
      where: { id: reservation.id, version: reservation.version },
      data: { ...ReservationMapper.toUpdate(reservation), version: { increment: 1 } },
    });
    if (count === 0) throw new ConcurrencyError('Reservation', reservation.id);
  }
}
