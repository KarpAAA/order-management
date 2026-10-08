import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { Clock } from '@shared/domain/clock';
import type { Inbox } from '@shared/messaging/inbox';

/**
 * The inbox in the database of the service (docs/adr/0015-idempotent-consumers.md): the row
 * of a message and what the message causes are committed together, or neither is.
 *
 *  - the row is written first, with `ON CONFLICT DO NOTHING`: a duplicate is no row inserted,
 *    not an error, so the transaction stays usable;
 *  - two deliveries of one message at once: the second insert waits on the primary key for
 *    the first transaction, then finds its row (a duplicate) or, after a rollback, no row;
 *  - the use case inside joins this transaction, so the tenant must be bound before the call.
 */
@Injectable()
export class PostgresInbox implements Inbox {
  constructor(
    private readonly txHost: TransactionHost<DbTransactionAdapter>,
    private readonly clock: Clock,
  ) {}

  once(consumer: string, messageId: string, handle: () => Promise<void>): Promise<boolean> {
    return this.txHost.withTransaction(async () => {
      const { count } = await this.txHost.tx.inboxMessage.createMany({
        data: [{ consumer, messageId, processedAt: this.clock.now() }],
        skipDuplicates: true,
      });
      if (count === 0) return false;
      await handle();
      return true;
    });
  }
}
