/**
 * The outside world failed. Adapters throw subclasses; `retryable` comes from the
 * vendor's signal (timeout, 429, 5xx → true; 4xx, auth → false).
 */
export abstract class InfrastructureError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
