import { Injectable } from '@nestjs/common';

import type { Actor } from '@shared/auth/actor';
import { ForbiddenError } from '@shared/errors/forbidden-error';

const CONSUMER_SOURCE = 'consumer:notifications';
const DISPATCHER_SOURCE = 'dispatcher:notifications';

/** Who may do what: a notification is owed on an event of the broker, and sent by the dispatcher. */
@Injectable()
export class NotificationsPolicy {
  assertCanRequest(actor: Actor): void {
    if (actor.source !== CONSUMER_SOURCE) throw new ForbiddenError('notifications.request');
  }

  assertCanDispatch(actor: Actor): void {
    if (actor.source !== DISPATCHER_SOURCE) throw new ForbiddenError('notifications.dispatch');
  }
}
