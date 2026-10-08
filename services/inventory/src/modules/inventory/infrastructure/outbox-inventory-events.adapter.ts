import { Injectable } from '@nestjs/common';
import {
  exchanges,
  StockAdjustedV1,
  StockReleasedV1,
  StockReservationFailedV1,
  StockReservedV1,
} from '@oms/contracts';

import { Outbox } from '@infra/outbox/outbox';
import type { OutboxEnvelope } from '@infra/outbox/outbox';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import { ReservationStatus } from '../domain/reservation-status';

import type { Reservation } from '../domain/reservation';
import type { StockItem } from '../domain/stock-item';
import type { InventoryEventsPublisher } from '../ports/inventory-events-publisher.port';
import type { AttemptKey } from '../ports/reservations-repository.port';
import type { MessageMeta } from '@oms/contracts';

/**
 * Writes the answer of a command to the outbox as an `inventory.*` event, in the transaction
 * of the use case: the stock says what the answer says, or neither exists. The relay
 * publishes it to the `events` exchange; the routing key is the name of the message, and who
 * reads it is not known here.
 */
@Injectable()
export class OutboxInventoryEventsPublisher implements InventoryEventsPublisher {
  constructor(
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  reservationAnswered(reservation: Reservation, correlationId: string): Promise<void> {
    const meta = this.meta(reservation.workspaceId, correlationId);
    const attempt = { orderId: reservation.orderId, attempt: reservation.attempt };
    switch (reservation.status) {
      case ReservationStatus.Reserved:
        return this.append(StockReservedV1.create(meta, attempt));
      case ReservationStatus.Rejected:
        return this.append(
          StockReservationFailedV1.create(meta, {
            ...attempt,
            reason: 'insufficient_stock',
            shortages: reservation.shortages,
          }),
        );
      case ReservationStatus.Released:
        // released before or after it was asked for: either way the attempt holds nothing
        return this.append(StockReleasedV1.create(meta, attempt));
    }
  }

  stockReleased({ workspaceId, orderId, attempt }: AttemptKey, correlationId: string) {
    const meta = this.meta(workspaceId, correlationId);
    return this.append(StockReleasedV1.create(meta, { orderId, attempt }));
  }

  stockAdjusted(item: StockItem, correlationId: string): Promise<void> {
    const { productId, onHand, reserved } = item;
    return this.append(
      StockAdjustedV1.create(this.meta(item.workspaceId, correlationId), {
        productId,
        onHand,
        reserved,
      }),
    );
  }

  private meta(workspaceId: string, correlationId: string): MessageMeta {
    return { messageId: newId(), occurredAt: this.clock.now(), workspaceId, correlationId };
  }

  private append(message: OutboxEnvelope): Promise<void> {
    return this.outbox.append({ exchange: exchanges.events.name, message });
  }
}
