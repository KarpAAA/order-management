import { Injectable } from '@nestjs/common';

import type { Actor } from '@shared/auth/actor';
import { ForbiddenError } from '@shared/errors/forbidden-error';

const CHARGER_SOURCE = 'consumer:payments';

/** Who may do what to a payment. Money moves only on a command from the broker. */
@Injectable()
export class PaymentsPolicy {
  assertCanCharge(actor: Actor): void {
    if (actor.source === CHARGER_SOURCE) return;
    throw new ForbiddenError('payments.charge');
  }
}
