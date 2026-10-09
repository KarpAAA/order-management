import { ConflictError, DomainError, InvalidStateError } from './domain-error';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** → 400: the route needs the header, and it is missing or not a uuid. */
export class IdempotencyKeyInvalidError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';

  constructor() {
    super(
      `${IDEMPOTENCY_KEY_HEADER} header is required: a uuid chosen by the client, the same on every retry of this request`,
    );
  }
}

/** → 422: the key was used for another request (another body) on this route. */
export class IdempotencyKeyReusedError extends InvalidStateError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(key: string) {
    super(`${IDEMPOTENCY_KEY_HEADER} ${key} was used with another request body`, { key });
  }
}

/** → 409 with `Retry-After`: the first request with this key has not been answered yet. */
export class IdempotencyKeyInProgressError extends ConflictError {
  readonly code = 'IDEMPOTENCY_KEY_IN_PROGRESS';

  constructor(key: string) {
    super(`A request with ${IDEMPOTENCY_KEY_HEADER} ${key} is being handled`, { key });
  }
}
