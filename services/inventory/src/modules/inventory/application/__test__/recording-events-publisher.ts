import type { Journal } from './fixtures';
import type { Reservation } from '../../domain/reservation';
import type { ReservationStatus } from '../../domain/reservation-status';
import type { StockItem } from '../../domain/stock-item';
import type { InventoryEventsPublisher } from '../../ports/inventory-events-publisher.port';
import type { AttemptKey } from '../../ports/reservations-repository.port';

export type Answer =
  | { answer: 'reservation'; status: ReservationStatus; orderId: string; attempt: number }
  | { answer: 'released'; orderId: string; attempt: number }
  | { answer: 'adjusted'; productId: string; onHand: number; reserved: number };

/** Spy: the answers a use case gave, in order, with the correlation id of each. */
export class RecordingEventsPublisher implements InventoryEventsPublisher {
  readonly answers: Answer[] = [];
  readonly correlationIds: string[] = [];

  constructor(private readonly journal: Journal = []) {}

  reservationAnswered(reservation: Reservation, correlationId: string): Promise<void> {
    const { status, orderId, attempt } = reservation;
    return this.record({ answer: 'reservation', status, orderId, attempt }, correlationId);
  }

  stockReleased({ orderId, attempt }: AttemptKey, correlationId: string): Promise<void> {
    return this.record({ answer: 'released', orderId, attempt }, correlationId);
  }

  stockAdjusted(item: StockItem, correlationId: string): Promise<void> {
    const { productId, onHand, reserved } = item;
    return this.record({ answer: 'adjusted', productId, onHand, reserved }, correlationId);
  }

  private record(answer: Answer, correlationId: string): Promise<void> {
    this.journal.push('answer');
    this.answers.push(answer);
    this.correlationIds.push(correlationId);
    return Promise.resolve();
  }
}
