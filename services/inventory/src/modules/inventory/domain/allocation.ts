import { InvalidQuantityError } from './errors';
import { Reservation } from './reservation';

import type { StockItem } from './stock-item';

export interface RequestedLine {
  productId: string;
  quantity: number;
}

export interface ReservationRequest {
  workspaceId: string;
  orderId: string;
  attempt: number;
  lines: readonly RequestedLine[];
}

/** One line per product, the quantities of a product asked twice added up. */
export function mergeLines(lines: readonly RequestedLine[]): RequestedLine[] {
  const byProduct = new Map<string, number>();
  for (const { productId, quantity } of lines) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InvalidQuantityError(productId, quantity);
    }
    byProduct.set(productId, (byProduct.get(productId) ?? 0) + quantity);
  }
  return [...byProduct].map(([productId, quantity]) => ({ productId, quantity }));
}

/**
 * Holds the stock an attempt of an order asks for: every line or none. The rule spans the
 * stock of several products and the reservation, so it lives here and not in either.
 *
 * `stock` holds the items of the requested products that exist; a product with no stock item
 * has nothing free. Every line is checked before anything is reserved, so a rejection leaves
 * the stock untouched and names every product that fell short, not only the first.
 */
export function allocate(
  request: ReservationRequest,
  stock: ReadonlyMap<string, StockItem>,
  now: Date,
): Reservation {
  const lines = mergeLines(request.lines).map((line) => ({
    ...line,
    free: stock.get(line.productId)?.available ?? 0,
  }));
  const attempt = {
    workspaceId: request.workspaceId,
    orderId: request.orderId,
    attempt: request.attempt,
    now,
  };

  if (lines.some((line) => line.quantity > line.free)) {
    return Reservation.reject({
      ...attempt,
      lines: lines.map(({ productId, quantity, free }) => ({
        productId,
        quantity,
        available: quantity > free ? free : null,
      })),
    });
  }

  for (const { productId, quantity } of lines) stock.get(productId)?.reserve(quantity, now);
  return Reservation.hold({
    ...attempt,
    lines: lines.map(({ productId, quantity }) => ({ productId, quantity })),
  });
}
