import { Inject, Injectable } from '@nestjs/common';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { TenantContext } from '@common/tenancy/tenant-context';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { INBOX, type Inbox } from '@shared/messaging/inbox';

/**
 * What `handleOnce()` works with (`interface/worker/handle-once.ts`), as one collaborator of
 * a broker consumer: the three consumers of orders need the same four, and a consumer has
 * its use cases to hold besides (code-style.md §2: six dependencies).
 */
@Injectable()
export class ConsumerScope {
  readonly logger: Logger;

  constructor(
    readonly tenant: TenantContext,
    readonly correlation: CorrelationContext,
    @Inject(INBOX) readonly inbox: Inbox,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ context: 'OrdersConsumers' });
  }
}
