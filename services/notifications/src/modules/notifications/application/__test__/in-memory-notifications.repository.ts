import { Notification } from '../../domain/notification';
import { NotificationStatus } from '../../domain/notification-status';

import type { NotificationsRepositoryPort } from '../../ports/notifications-repository.port';

const factOf = ({ orderId, kind, attempt }: Notification): string =>
  `${orderId}:${kind}:${String(attempt)}`;

/** Fake: notifications in a map, with the unique key of the real table and its order of work. */
export class InMemoryNotificationsRepository implements NotificationsRepositoryPort {
  private readonly rows = new Map<string, Notification>();

  put(notification: Notification): void {
    this.rows.set(notification.id, Notification.restore(notification.snapshot()));
  }

  all(): Notification[] {
    return [...this.rows.values()];
  }

  get(id: string): Notification {
    const found = this.rows.get(id);
    if (!found) throw new Error(`no notification ${id}`);
    return found;
  }

  insertIfAbsent(notification: Notification): Promise<boolean> {
    const fact = factOf(notification);
    if (this.all().some((row) => factOf(row) === fact)) return Promise.resolve(false);
    this.put(notification);
    return Promise.resolve(true);
  }

  lockNextDue(now: Date): Promise<Notification | null> {
    const due = this.all()
      .map((row) => row.snapshot())
      .filter(
        ({ status, nextAttemptAt }) =>
          status === NotificationStatus.Pending && nextAttemptAt !== null && nextAttemptAt <= now,
      )
      .sort((a, b) => (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0));
    const [first] = due;
    return Promise.resolve(first ? Notification.restore(first) : null);
  }

  save(notification: Notification): Promise<void> {
    if (!this.rows.has(notification.id)) throw new Error(`no notification ${notification.id}`);
    this.put(notification);
    return Promise.resolve();
  }
}
