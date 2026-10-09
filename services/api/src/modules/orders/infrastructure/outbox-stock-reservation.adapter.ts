import { Injectable } from '@nestjs/common';
import { exchanges, ReleaseStockV1, ReserveStockV1 } from '@oms/contracts';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { Outbox } from '@infra/outbox/outbox';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import type {
  RequestedReservation,
  ReservationAttempt,
  StockReservationScheduler,
} from '../ports/stock-reservation-scheduler.port';
import type { MessageMeta } from '@oms/contracts';

/**
 * Writes the commands for inventory-service to the outbox, in the transaction of the use
 * case that calls it. The relay of the worker publishes them to the `commands` exchange; the
 * routing key is the name of the command, and inventory-service binds its queue with it.
 *
 * `attempt` is the payment attempt of the order: placed again, an order asks for a new
 * reservation, and a late command of the first placing is not mistaken for it (ADR 0016).
 */
@Injectable()
export class OutboxStockReservationAdapter implements StockReservationScheduler {
  constructor(
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly correlation: CorrelationContext,
  ) {}

  async reserve(reservation: RequestedReservation): Promise<void> {
    const message = ReserveStockV1.create(this.meta(reservation.workspaceId), {
      orderId: reservation.orderId,
      attempt: reservation.attempt,
      lines: reservation.lines.map(({ productId, quantity }) => ({ productId, quantity })),
    });

    await this.outbox.append({ exchange: exchanges.commands.name, message });
  }

  async release(attempt: ReservationAttempt): Promise<void> {
    const message = ReleaseStockV1.create(this.meta(attempt.workspaceId), {
      orderId: attempt.orderId,
      attempt: attempt.attempt,
    });

    await this.outbox.append({ exchange: exchanges.commands.name, message });
  }

  private meta(workspaceId: string): MessageMeta {
    return {
      messageId: newId(),
      occurredAt: this.clock.now(),
      workspaceId,
      // the answer of inventory carries it back
      correlationId: this.correlation.id(),
    };
  }
}
