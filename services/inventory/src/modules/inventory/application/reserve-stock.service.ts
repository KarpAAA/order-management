import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';

import { allocate } from '../domain/allocation';
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

import type { ReserveStockCommand } from './inventory-commands';

/**
 * Holds stock for one attempt of an order, every line or none, and answers.
 *
 * The stock is locked before anything is read. Two commands that want the last unit of a
 * product are then handled one after the other: the second waits for the first to commit and
 * decides on what the first left. Without the lock both would read "1 free" and both would
 * hold it.
 *
 * The lock also puts two deliveries for the same attempt in a row, so the second finds the
 * reservation of the first and only answers. When the products have no stock to lock, both
 * insert, the unique key of the attempt refuses one, and its message comes again.
 */
@Injectable()
export class ReserveStockService {
  constructor(
    @Inject(STOCK_REPOSITORY) private readonly stock: StockRepositoryPort,
    @Inject(RESERVATIONS_REPOSITORY) private readonly reservations: ReservationsRepositoryPort,
    private readonly policy: InventoryPolicy,
    private readonly clock: Clock,
    @Inject(INVENTORY_EVENTS_PUBLISHER) private readonly publisher: InventoryEventsPublisher,
  ) {}

  @Transactional()
  async execute(cmd: ReserveStockCommand, actor: Actor): Promise<void> {
    this.policy.assertCanReserve(actor);

    const productIds = [...new Set(cmd.lines.map((line) => line.productId))];
    const stock = await this.stock.lockMany(cmd.workspaceId, productIds);

    const settled = await this.reservations.findByAttempt(cmd);
    if (settled) {
      // asked again, or released before it was asked for: nothing changes, the answer does not
      await this.publisher.reservationAnswered(settled, cmd.correlationId);
      return;
    }

    const reservation = allocate(cmd, stock, this.clock.now());
    if (reservation.holdsStock) await this.stock.saveAll([...stock.values()]);
    await this.reservations.insert(reservation);
    await this.publisher.reservationAnswered(reservation, cmd.correlationId);
  }
}
