import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import type { DbTransactionAdapter } from '@infra/database/transactional.adapter';
import { Clock } from '@shared/domain/clock';

/**
 * The inbox (docs/adr/0015-idempotent-consumers.md): a message a consumer has handled is a
 * row written in the transaction of what the message caused, so both are committed or
 * neither is, and the same message takes effect once.
 *
 * Unlike in the api, the caller opens the transaction: the use case of this service calls
 * the provider first, outside any transaction, and only its last step is one.
 */
@Injectable()
export class Inbox {
  constructor(
    private readonly txHost: TransactionHost<DbTransactionAdapter>,
    private readonly clock: Clock,
  ) {}

  /**
   * Records the message for the consumer. False: it was recorded before, a duplicate.
   * `ON CONFLICT DO NOTHING`, so a duplicate does not abort the transaction. A delivery of
   * the same message that is still inside its transaction makes this one wait for it.
   */
  async record(consumer: string, messageId: string): Promise<boolean> {
    if (!this.txHost.isTransactionActive()) {
      // outside a transaction the row would say "handled" about work that may still fail
      throw new Error(`Inbox.record(${consumer}) must be called inside a transaction`);
    }
    const { count } = await this.txHost.tx.inboxMessage.createMany({
      data: [{ consumer, messageId, processedAt: this.clock.now() }],
      skipDuplicates: true,
    });
    return count === 1;
  }
}
