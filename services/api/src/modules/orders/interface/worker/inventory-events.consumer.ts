import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import {
  exchanges,
  parseMessage,
  StockReleasedV1,
  StockReservationFailedV1,
  StockReservedV1,
} from '@oms/contracts';

import { systemActor } from '@shared/auth/actor';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';

import { ConfirmStockReleaseService } from '../../application/confirm-stock-release.service';
import { ConfirmStockReservationService } from '../../application/confirm-stock-reservation.service';
import { RejectStockReservationService } from '../../application/reject-stock-reservation.service';
import { ConsumerScope } from '../../infrastructure/consumer-scope';

import { handleOnce } from './handle-once';

import type { AnyMessage } from '@oms/contracts';

const ACTOR = systemActor('consumer:orders');

/** The queue of the api on the `events` exchange: what inventory-service says about a reservation. */
const INVENTORY_EVENTS_QUEUE = 'api.inventory-events';

/**
 * The answers to `inventory.reserve-stock` and `inventory.release-stock`: the steps of the
 * saga that inventory decides. Thin, like `PaymentEventsConsumer`: the contract, then
 * `handleOnce()` with one use case. `inventory.stock-adjusted` is not bound: no order waits
 * for it.
 */
@Injectable()
export class InventoryEventsConsumer {
  constructor(
    private readonly scope: ConsumerScope,
    private readonly confirmReservation: ConfirmStockReservationService,
    private readonly rejectReservation: RejectStockReservationService,
    private readonly confirmRelease: ConfirmStockReleaseService,
  ) {}

  // the queue's arguments and its retry policy are added by RabbitSubscribers, from the config
  @RabbitSubscribe({
    exchange: exchanges.events.name,
    routingKey: [StockReservedV1.name, StockReservationFailedV1.name, StockReleasedV1.name],
    queue: INVENTORY_EVENTS_QUEUE,
  })
  async onInventoryEvent(raw: unknown): Promise<void> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: another delivery cannot help
      throw new UnprocessableMessageError(`${parsed.reason}: ${parsed.detail}`);
    }
    const { message } = parsed;
    await handleOnce(this.scope, INVENTORY_EVENTS_QUEUE, message, () => this.advance(message));
  }

  private async advance(message: AnyMessage): Promise<void> {
    switch (message.name) {
      case StockReservedV1.name: {
        const { orderId, attempt } = message.payload;
        await this.confirmReservation.execute({ orderId, attempt }, ACTOR);
        return;
      }
      case StockReservationFailedV1.name: {
        const { orderId, attempt, shortages } = message.payload;
        await this.rejectReservation.execute({ orderId, attempt, shortages }, ACTOR);
        return;
      }
      case StockReleasedV1.name: {
        const { orderId, attempt } = message.payload;
        await this.confirmRelease.execute({ orderId, attempt }, ACTOR);
        return;
      }
      default:
        throw new UnprocessableMessageError(`${message.name} is not an event of this queue`);
    }
  }
}
