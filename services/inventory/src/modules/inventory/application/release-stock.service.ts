import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';

import { Reservation } from '../domain/reservation';
import {
  INVENTORY_EVENTS_PUBLISHER,
  type InventoryEventsPublisher,
} from '../ports/inventory-events-publisher.port';
import {
  RESERVATIONS_REPOSITORY,
  type ReservationsRepositoryPort,
} from '../ports/reservations-repository.port';
import { STOCK_REPOSITORY, type StockRepositoryPort } from '../ports/stock-repository.port';

import { InventoryPolicy } from './inventory.policy';

import type { ReleaseStockCommand } from './inventory-commands';

/**
 * Gives back what one attempt of an order holds, and answers that it holds nothing.
 *
 *  - RESERVED: the lines go back to the stock, once. Two releases of one reservation both
 *    read RESERVED; the version of the reservation lets one of them save, and the other is
 *    refused, rolled back, and comes again to find it RELEASED.
 *  - REJECTED or RELEASED: nothing is held, nothing changes.
 *  - no reservation: the release came before its reserve. The attempt is recorded as
 *    RELEASED, so the reserve that comes later holds nothing.
 */
@Injectable()
export class ReleaseStockService {
  constructor(
    @Inject(STOCK_REPOSITORY) private readonly stock: StockRepositoryPort,
    @Inject(RESERVATIONS_REPOSITORY) private readonly reservations: ReservationsRepositoryPort,
    private readonly policy: InventoryPolicy,
    private readonly clock: Clock,
    @Inject(INVENTORY_EVENTS_PUBLISHER) private readonly publisher: InventoryEventsPublisher,
  ) {}

  @Transactional()
  async execute(cmd: ReleaseStockCommand, actor: Actor): Promise<void> {
    this.policy.assertCanRelease(actor);
    const now = this.clock.now();

    const reservation = await this.reservations.findByAttempt(cmd);
    if (!reservation) {
      const ahead = Reservation.releaseAhead({
        workspaceId: cmd.workspaceId,
        orderId: cmd.orderId,
        attempt: cmd.attempt,
        now,
      });
      await this.reservations.insert(ahead);
    } else if (reservation.holdsStock) {
      await this.giveBack(reservation, now);
    }

    await this.publisher.stockReleased(cmd, cmd.correlationId);
  }

  /**
   * The reservation is saved before the stock is touched: of two releases only one gets past
   * this save, so the stock is given back by one of them.
   */
  private async giveBack(reservation: Reservation, now: Date): Promise<void> {
    reservation.release(now);
    await this.reservations.save(reservation);

    const productIds = reservation.lines.map((line) => line.productId);
    const stock = await this.stock.lockMany(reservation.workspaceId, productIds);
    for (const { productId, quantity } of reservation.lines) {
      stock.get(productId)?.release(quantity, now);
    }
    await this.stock.saveAll([...stock.values()]);
  }
}
