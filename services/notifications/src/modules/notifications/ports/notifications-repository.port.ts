import type { Notification } from '../domain/notification';

export const NOTIFICATIONS_REPOSITORY = Symbol('NOTIFICATIONS_REPOSITORY');

export interface NotificationsRepositoryPort {
  /**
   * Writes the notification unless one about the same fact `(orderId, kind, attempt)` is
   * there. `false`: it was, and nothing is written. Not an error: another message about a
   * fact the user was already told is expected, and the transaction stays usable.
   */
  insertIfAbsent(notification: Notification): Promise<boolean>;
  /**
   * The notification that has waited longest among those due at `now`, with its row locked
   * until the transaction ends, or `null` when none is due or every due one is being sent by
   * another process. Inside a transaction only: the lock is what keeps two dispatchers from
   * sending the same mail.
   */
  lockNextDue(now: Date): Promise<Notification | null>;
  /** What a try changed, on a row this transaction holds. */
  save(notification: Notification): Promise<void>;
}
