import { ConflictError, DomainError, InvalidStateError } from '@shared/errors/domain-error';

import type { ReservationStatus } from './reservation-status';

/** A number of units that is not a positive whole number. */
export class InvalidQuantityError extends DomainError {
  readonly code = 'INVALID_QUANTITY';

  constructor(productId: string, quantity: number) {
    super(`${quantity} is not a number of units of product ${productId}`, { productId, quantity });
  }
}

export class InsufficientStockError extends InvalidStateError {
  readonly code = 'INSUFFICIENT_STOCK';

  constructor(productId: string, requested: number, available: number) {
    super(`Product ${productId} has ${available} free, ${requested} asked`, {
      productId,
      requested,
      available,
    });
  }
}

/** More is given back than is held: the stock and its reservations disagree. */
export class StockNotHeldError extends InvalidStateError {
  readonly code = 'STOCK_NOT_HELD';

  constructor(productId: string, quantity: number, reserved: number) {
    super(`Product ${productId} holds ${reserved}, ${quantity} cannot be given back`, {
      productId,
      quantity,
      reserved,
    });
  }
}

/** Stock that reservations hold cannot leave: release them first. */
export class StockBelowReservedError extends InvalidStateError {
  readonly code = 'STOCK_BELOW_RESERVED';

  constructor(productId: string, onHand: number, reserved: number) {
    super(`Product ${productId} cannot go to ${onHand} on hand with ${reserved} reserved`, {
      productId,
      onHand,
      reserved,
    });
  }
}

export class ReservationNotHeldError extends InvalidStateError {
  readonly code = 'RESERVATION_NOT_HELD';

  constructor(reservationId: string, status: ReservationStatus) {
    super(`Reservation ${reservationId} is ${status} and holds nothing to release`, {
      reservationId,
      status,
    });
  }
}

/** The attempt of the order belongs to another workspace than the command says. */
export class ReservationOfAnotherWorkspaceError extends InvalidStateError {
  readonly code = 'RESERVATION_OF_ANOTHER_WORKSPACE';

  constructor(orderId: string, attempt: number) {
    super(`Attempt ${attempt} of order ${orderId} is not in this workspace`, { orderId, attempt });
  }
}

/** Another delivery wrote the reservation of this attempt first. */
export class ReservationAlreadyExistsError extends ConflictError {
  readonly code = 'RESERVATION_ALREADY_EXISTS';

  constructor(orderId: string, attempt: number) {
    super(`Attempt ${attempt} of order ${orderId} already has a reservation`, { orderId, attempt });
  }
}

/** Another delivery opened the stock of this product first. */
export class StockItemAlreadyExistsError extends ConflictError {
  readonly code = 'STOCK_ITEM_ALREADY_EXISTS';

  constructor(productId: string) {
    super(`Product ${productId} already has stock`, { productId });
  }
}
