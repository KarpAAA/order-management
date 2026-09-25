/**
 * Business said no. Every module error extends one of the three bases below;
 * the exception filter maps by base class (http/error-handling.md §1).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** → 404 */
export abstract class NotFoundError extends DomainError {}

/** → 409: re-read and retry (duplicate, stale version). */
export abstract class ConflictError extends DomainError {}

/** → 422: this action is not possible in the current state. */
export abstract class InvalidStateError extends DomainError {}

/** The client acted on a version it no longer has. */
export class StaleVersionError extends ConflictError {
  readonly code = 'STALE_VERSION';

  constructor(entity: string, id: string, expected: number, actual: number) {
    super(`${entity} ${id} is at version ${actual}, not ${expected}`, {
      entity,
      id,
      expectedVersion: expected,
      actualVersion: actual,
    });
  }
}

/** A concurrent writer saved the aggregate between our load and our save. */
export class ConcurrencyError extends ConflictError {
  readonly code = 'CONCURRENT_MODIFICATION';

  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified concurrently`, { entity, id });
  }
}
