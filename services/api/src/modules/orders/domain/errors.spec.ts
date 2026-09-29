import { describe, expect, it } from 'vitest';

import type { DomainError } from '@shared/errors/domain-error';

import {
  InvalidOrderError,
  OrderHasNoItemsError,
  OrderInvalidTransitionError,
  OrderNotEditableError,
  OrderNotFoundError,
  OrderProductNotFoundError,
  PaymentAttemptNotPendingError,
  ProductNotActiveError,
} from './errors';
import { OrderStatus } from './order-status';

/**
 * `code` and `details` go into the error response body (http/error-handling.md) and clients
 * branch on `code`. The codes are copied by hand from docs/requirements.md, on purpose NOT
 * read from the classes: a test derived from the code it tests would agree with any rename.
 */
const CASES: readonly [DomainError, string, Record<string, unknown>][] = [
  [new OrderNotFoundError('o-1'), 'ORDER_NOT_FOUND', { orderId: 'o-1' }],
  [
    new OrderInvalidTransitionError('o-1', 'cancel', OrderStatus.Paid),
    'ORDER_INVALID_TRANSITION',
    { orderId: 'o-1', action: 'cancel', status: 'PAID' },
  ],
  [
    new OrderNotEditableError('o-1', OrderStatus.Paid),
    'ORDER_NOT_EDITABLE',
    { orderId: 'o-1', status: 'PAID' },
  ],
  [new OrderHasNoItemsError('o-1'), 'ORDER_HAS_NO_ITEMS', { orderId: 'o-1' }],
  [
    new PaymentAttemptNotPendingError('o-1', 1, OrderStatus.Paid, 2),
    'PAYMENT_ATTEMPT_NOT_PENDING',
    { orderId: 'o-1', attempt: 1, status: 'PAID', currentAttempt: 2 },
  ],
  [new ProductNotActiveError('p-1'), 'PRODUCT_NOT_ACTIVE', { productId: 'p-1' }],
  [new OrderProductNotFoundError('p-1'), 'PRODUCT_NOT_FOUND', { productId: 'p-1' }],
  [new InvalidOrderError('bad', { count: 51 }), 'INVALID_ORDER', { count: 51 }],
];

describe('orders errors', () => {
  it.each(CASES)('%s answers with code %s and its details', (error, code, details) => {
    expect(error.code).toBe(code);
    expect(error.details).toEqual(details);
  });
});
