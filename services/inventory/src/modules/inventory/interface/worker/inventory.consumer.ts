import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Inject, Injectable } from '@nestjs/common';
import {
  AdjustStockV1,
  exchanges,
  parseMessage,
  ReleaseStockV1,
  ReserveStockV1,
} from '@oms/contracts';

import { systemActor } from '@shared/auth/actor';
import { ConflictError, DomainError } from '@shared/errors/domain-error';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { INBOX, type Inbox } from '@shared/messaging/inbox';

import { AdjustStockService } from '../../application/adjust-stock.service';
import { ReleaseStockService } from '../../application/release-stock.service';
import { ReserveStockService } from '../../application/reserve-stock.service';

import type { AnyMessage } from '@oms/contracts';

const ACTOR = systemActor('consumer:inventory');

/** The queue of this service: every command addressed to inventory lands here. */
const INVENTORY_COMMANDS_QUEUE = 'inventory.commands';

/**
 * Thin: validate the message against its contract, build the actor, call one use case, once
 * per message: the inbox records the message in the transaction of the use case, and a
 * message that was recorded before is acknowledged without a call
 * (docs/adr/0015-idempotent-consumers.md).
 * Returning acknowledges the message. Whatever is thrown is settled by the connection
 * (infrastructure/messaging/retry-or-park.ts): delivered again after a delay, or parked in
 * `inventory.commands.dlq` when it is an `UnprocessableMessageError` or the last delivery.
 */
@Injectable()
export class InventoryConsumer {
  private readonly log: Logger;

  constructor(
    @Inject(INBOX) private readonly inbox: Inbox,
    private readonly reserveStock: ReserveStockService,
    private readonly releaseStock: ReleaseStockService,
    private readonly adjustStock: AdjustStockService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: InventoryConsumer.name });
  }

  // the queue's arguments and its retry policy are added by RabbitSubscribers, from the config
  @RabbitSubscribe({
    exchange: exchanges.commands.name,
    routingKey: [ReserveStockV1.name, ReleaseStockV1.name, AdjustStockV1.name],
    queue: INVENTORY_COMMANDS_QUEUE,
  })
  async onCommand(raw: unknown): Promise<void> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: another delivery cannot help
      throw new UnprocessableMessageError(`${parsed.reason}: ${parsed.detail}`);
    }
    const { message } = parsed;
    let fresh: boolean;
    try {
      fresh = await this.inbox.once(INVENTORY_COMMANDS_QUEUE, message.messageId, () =>
        this.handle(message),
      );
    } catch (err: unknown) {
      // Another writer was first (the same attempt, the same new product, a reservation that
      // changed meanwhile): the next delivery finds what that writer left. Anything that is
      // not a business answer (the database, a bug) may pass as well.
      if (err instanceof ConflictError || !(err instanceof DomainError)) throw err;
      // Business said no and will say it again: stock that is held cannot leave, the attempt
      // belongs to another workspace.
      throw new UnprocessableMessageError(`${err.code}: ${err.message}`, { cause: err });
    }
    if (!fresh) {
      // the same message again (the broker, the relay of the sender, an operator): done before
      this.log.info(
        { messageName: message.name, messageId: message.messageId, reason: 'duplicate' },
        'message skipped',
      );
    }
  }

  private async handle(message: AnyMessage): Promise<void> {
    const { workspaceId, correlationId } = message;
    switch (message.name) {
      case ReserveStockV1.name:
        await this.reserveStock.execute({ workspaceId, correlationId, ...message.payload }, ACTOR);
        return;
      case ReleaseStockV1.name:
        await this.releaseStock.execute({ workspaceId, correlationId, ...message.payload }, ACTOR);
        return;
      case AdjustStockV1.name:
        await this.adjustStock.execute({ workspaceId, correlationId, ...message.payload }, ACTOR);
        return;
      default:
        throw new UnprocessableMessageError(`${message.name} is not a command of this queue`);
    }
  }
}
