import { Injectable } from '@nestjs/common';

import type { Actor } from '@shared/auth/actor';
import { ForbiddenError } from '@shared/errors/forbidden-error';

const CONSUMER_SOURCE = 'consumer:inventory';

/** Who may do what to the stock. It changes only on a command from the broker. */
@Injectable()
export class InventoryPolicy {
  assertCanReserve(actor: Actor): void {
    this.assertConsumer(actor, 'inventory.reserve');
  }

  assertCanRelease(actor: Actor): void {
    this.assertConsumer(actor, 'inventory.release');
  }

  assertCanAdjust(actor: Actor): void {
    this.assertConsumer(actor, 'inventory.adjust');
  }

  private assertConsumer(actor: Actor, action: string): void {
    if (actor.source === CONSUMER_SOURCE) return;
    throw new ForbiddenError(action);
  }
}
