/**
 * Business said no. Every module error extends one of the bases below; the consumer decides
 * by base class what happens to the message that caused it.
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

/** Another writer was first (a duplicate, a stale version): the next delivery finds its row. */
export abstract class ConflictError extends DomainError {}

/** This action is not possible in the current state, and another delivery will not change that. */
export abstract class InvalidStateError extends DomainError {}

/** A concurrent writer saved the aggregate between our load and our save. */
export class ConcurrencyError extends ConflictError {
  readonly code = 'CONCURRENT_MODIFICATION';

  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified concurrently`, { entity, id });
  }
}
