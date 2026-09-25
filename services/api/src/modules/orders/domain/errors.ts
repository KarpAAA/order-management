import { DomainError, InvalidStateError, NotFoundError } from '@shared/errors/domain-error';

import type { OrderStatus } from './order-status';

export class OrderNotFoundError extends NotFoundError {
  readonly code = 'ORDER_NOT_FOUND';

  constructor(orderId: string) {
    super(`Order ${orderId} not found`, { orderId });
  }
}

export class OrderInvalidTransitionError extends InvalidStateError {
  readonly code = 'ORDER_INVALID_TRANSITION';

  constructor(orderId: string, action: string, from: OrderStatus) {
    super(`Order ${orderId} cannot ${action} from ${from}`, { orderId, action, status: from });
  }
}

export class OrderNotEditableError extends InvalidStateError {
  readonly code = 'ORDER_NOT_EDITABLE';

  constructor(orderId: string, status: OrderStatus) {
    super(`Order ${orderId} is ${status}; items and discount change only in DRAFT`, {
      orderId,
      status,
    });
  }
}

export class OrderHasNoItemsError extends InvalidStateError {
  readonly code = 'ORDER_HAS_NO_ITEMS';

  constructor(orderId: string) {
    super(`Order ${orderId} has no items and cannot be placed`, { orderId });
  }
}

/** The job's payment attempt is not the one the order is waiting for (stale or duplicate job). */
export class PaymentAttemptNotPendingError extends InvalidStateError {
  readonly code = 'PAYMENT_ATTEMPT_NOT_PENDING';

  constructor(orderId: string, attempt: number, status: OrderStatus, currentAttempt: number) {
    super(`Order ${orderId} is not awaiting payment attempt ${attempt}`, {
      orderId,
      attempt,
      status,
      currentAttempt,
    });
  }
}

export class ProductNotActiveError extends InvalidStateError {
  readonly code = 'PRODUCT_NOT_ACTIVE';

  constructor(productId: string) {
    super(`Product ${productId} is archived and cannot be ordered`, { productId });
  }
}

export class OrderProductNotFoundError extends NotFoundError {
  readonly code = 'PRODUCT_NOT_FOUND';

  constructor(productId: string) {
    super(`Product ${productId} not found`, { productId });
  }
}

/** Input that breaks an order invariant. The DTO rejects the same shapes first (400). */
export class InvalidOrderError extends DomainError {
  readonly code = 'INVALID_ORDER';
}
