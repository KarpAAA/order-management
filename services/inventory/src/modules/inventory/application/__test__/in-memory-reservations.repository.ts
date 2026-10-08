import { ConcurrencyError } from '@shared/errors/domain-error';

import {
  ReservationAlreadyExistsError,
  ReservationOfAnotherWorkspaceError,
} from '../../domain/errors';
import { Reservation } from '../../domain/reservation';

import type { Journal } from './fixtures';
import type {
  AttemptKey,
  ReservationsRepositoryPort,
} from '../../ports/reservations-repository.port';

const keyOf = ({ orderId, attempt }: Omit<AttemptKey, 'workspaceId'>): string =>
  `${orderId}:${String(attempt)}`;

/** Fake: reservations in a map, with the unique key and the version check of the real one. */
export class InMemoryReservationsRepository implements ReservationsRepositoryPort {
  private readonly rows = new Map<string, Reservation>();

  constructor(private readonly journal: Journal = []) {}

  put(reservation: Reservation): void {
    this.rows.set(keyOf(reservation), reservation);
  }

  all(): Reservation[] {
    return [...this.rows.values()];
  }

  findByAttempt(key: AttemptKey): Promise<Reservation | null> {
    this.journal.push('find reservation');
    const found = this.rows.get(keyOf(key));
    if (!found) return Promise.resolve(null);
    if (found.workspaceId !== key.workspaceId) {
      throw new ReservationOfAnotherWorkspaceError(key.orderId, key.attempt);
    }
    return Promise.resolve(Reservation.restore(found.snapshot()));
  }

  insert(reservation: Reservation): Promise<void> {
    if (this.rows.has(keyOf(reservation))) {
      throw new ReservationAlreadyExistsError(reservation.orderId, reservation.attempt);
    }
    this.journal.push('insert reservation');
    this.put(reservation);
    return Promise.resolve();
  }

  save(reservation: Reservation): Promise<void> {
    const stored = this.rows.get(keyOf(reservation));
    if (stored?.version !== reservation.version) {
      throw new ConcurrencyError('Reservation', reservation.id);
    }
    this.journal.push('save reservation');
    this.put(Reservation.restore({ ...reservation.snapshot(), version: reservation.version + 1 }));
    return Promise.resolve();
  }
}
