import { Injectable } from '@nestjs/common';

import { IdentityFacade } from '@modules/identity';

import type { OrderRecipient, OrderRecipients } from '../ports/order-recipients.port';

/**
 * The recipient of an order event, read through the facade of identity, like
 * `OrderInputsReader` reads what an order is created from. Behind a port because the one
 * who asks is the translator in `infrastructure/`, which may not reach another module.
 */
@Injectable()
export class OrderRecipientsReader implements OrderRecipients {
  constructor(private readonly identity: IdentityFacade) {}

  of(userId: string): Promise<OrderRecipient> {
    return this.identity.getUserContact(userId);
  }
}
