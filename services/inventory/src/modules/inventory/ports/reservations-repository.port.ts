import type { Reservation } from '../domain/reservation';

export const RESERVATIONS_REPOSITORY = Symbol('RESERVATIONS_REPOSITORY');

/** The key of a reservation as the commands name it. */
export interface AttemptKey {
  workspaceId: string;
  orderId: string;
  attempt: number;
}

export interface ReservationsRepositoryPort {
  /**
   * The reservation of this attempt of the order, if any was written.
   * Throws `ReservationOfAnotherWorkspaceError` when the attempt exists in another workspace.
   */
  findByAttempt(key: AttemptKey): Promise<Reservation | null>;
  /** Throws `ReservationAlreadyExistsError` when another transaction wrote the attempt first. */
  insert(reservation: Reservation): Promise<void>;
  /** Throws `ConcurrencyError` when the reservation changed since it was loaded. */
  save(reservation: Reservation): Promise<void>;
}
