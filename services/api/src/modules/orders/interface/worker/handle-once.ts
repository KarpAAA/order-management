import type { CorrelationContext } from '@common/messaging/correlation-context';
import type { TenantContext } from '@common/tenancy/tenant-context';
import { ConflictError, DomainError, InvalidStateError } from '@shared/errors/domain-error';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import type { Logger } from '@shared/logger/logger';
import type { Inbox } from '@shared/messaging/inbox';

/** What every message has that is read from the broker: the envelope of `@oms/contracts`. */
export interface HandledMessage {
  name: string;
  messageId: string;
  workspaceId: string;
  correlationId: string;
}

/** What a message is handled with: `ConsumerScope` (infrastructure/) in the worker. */
export interface MessageScope {
  tenant: Pick<TenantContext, 'runInWorkspace'>;
  correlation: Pick<CorrelationContext, 'continue'>;
  inbox: Inbox;
  logger: Logger;
}

/**
 * What the broker consumers of orders do with a message that passed its contract: bind the
 * tenant from the envelope, continue its correlation, and run `handle` (one use case) once
 * per message, in the transaction of the inbox (docs/adr/0015-idempotent-consumers.md).
 *
 * Returning acknowledges the message. What `handle` throws decides the rest:
 *  - `InvalidStateError`: the order or its saga is not waiting for this. Done, not failed:
 *    the message came twice, late, or for an earlier attempt → acknowledged, with a warning;
 *  - `ConflictError`, or anything that is not a business answer (the database, a bug) →
 *    thrown on: the message is delivered again after a delay (docs/adr/0013);
 *  - any other `DomainError` (no such order in this workspace): business said no and will
 *    say it again → `UnprocessableMessageError`, parked at once.
 */
export async function handleOnce(
  { tenant, correlation, inbox, logger }: MessageScope,
  queue: string,
  message: HandledMessage,
  handle: () => Promise<void>,
): Promise<void> {
  const skipped = { messageName: message.name, messageId: message.messageId };
  let fresh: boolean;
  try {
    // the tenant first: the transaction of the inbox is the one the use case joins
    fresh = await tenant.runInWorkspace(message.workspaceId, () => {
      // what the order publishes next belongs to the chain this message is part of
      correlation.continue(message.correlationId);
      return inbox.once(queue, message.messageId, handle);
    });
  } catch (err: unknown) {
    if (err instanceof InvalidStateError) {
      logger.warn({ ...skipped, reason: err.code }, 'message skipped');
      return;
    }
    // A concurrent writer won: the next delivery finds the order as that writer left it.
    if (err instanceof ConflictError || !(err instanceof DomainError)) throw err;
    throw new UnprocessableMessageError(`${err.code}: ${err.message}`, { cause: err });
  }
  if (!fresh) {
    // the same message again (the broker, the relay of the sender, an operator): done before
    logger.info({ ...skipped, reason: 'duplicate' }, 'message skipped');
  }
}
