import type { AttemptKey } from './reservations-repository.port';
import type { Reservation } from '../domain/reservation';
import type { StockItem } from '../domain/stock-item';

export const INVENTORY_EVENTS_PUBLISHER = Symbol('INVENTORY_EVENTS_PUBLISHER');

/**
 * Tells the rest of the system what a command left behind.
 *
 * An answer is read from the state, not recorded by the change: a command that finds its work
 * done changes nothing and is answered all the same, because whoever sent it is waiting.
 * `correlationId` is the one of the command being answered.
 *
 * Called inside the transaction of the use case, and that is the contract of this port: the
 * answer is recorded with the rows it tells about (an outbox row), never sent to the outside
 * from here. An adapter that calls a broker does not belong behind it.
 */
export interface InventoryEventsPublisher {
  /** The answer to `reserve`: held, rejected with its shortages, or released ahead of it. */
  reservationAnswered(reservation: Reservation, correlationId: string): Promise<void>;
  /** The answer to `release`: this attempt of the order holds nothing. */
  stockReleased(attempt: AttemptKey, correlationId: string): Promise<void>;
  /** The answer to `adjust`: the levels of the product after the change. */
  stockAdjusted(item: StockItem, correlationId: string): Promise<void>;
}
