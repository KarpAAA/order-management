// layered · L4 · together
import { Module } from '@nestjs/common';

import { AdjustStockService } from './application/adjust-stock.service';
import { InventoryPolicy } from './application/inventory.policy';
import { ReleaseStockService } from './application/release-stock.service';
import { ReserveStockService } from './application/reserve-stock.service';
import { OutboxInventoryEventsPublisher } from './infrastructure/outbox-inventory-events.adapter';
import { ReservationsRepository } from './infrastructure/reservations.repository';
import { StockRepository } from './infrastructure/stock.repository';
import { INVENTORY_EVENTS_PUBLISHER } from './ports/inventory-events-publisher.port';
import { RESERVATIONS_REPOSITORY } from './ports/reservations-repository.port';
import { STOCK_REPOSITORY } from './ports/stock-repository.port';

const USE_CASES = [ReserveStockService, ReleaseStockService, AdjustStockService];

@Module({
  providers: [
    // write
    ...USE_CASES,
    InventoryPolicy,
    { provide: STOCK_REPOSITORY, useClass: StockRepository },
    { provide: RESERVATIONS_REPOSITORY, useClass: ReservationsRepository },
    // the answer is a row of the outbox, written with the stock it tells about
    { provide: INVENTORY_EVENTS_PUBLISHER, useClass: OutboxInventoryEventsPublisher },
  ],
  // No facade: no other module exists. The use cases are exported to the module's own
  // transport module only (Nest needs them exported to inject them into the consumer).
  exports: USE_CASES,
})
export class InventoryModule {}
