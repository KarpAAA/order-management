import { InvalidStateError } from '@shared/errors/domain-error';

import type { NotificationStatus } from './notification-status';

/** A notification that was sent or given up is not sent again. */
export class NotificationNotPendingError extends InvalidStateError {
  readonly code = 'NOTIFICATION_NOT_PENDING';

  constructor(notificationId: string, status: NotificationStatus) {
    super(`Notification ${notificationId} is ${status} and is not waiting to be sent`, {
      notificationId,
      status,
    });
  }
}
