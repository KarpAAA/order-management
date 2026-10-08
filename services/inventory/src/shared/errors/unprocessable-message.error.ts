import { InfrastructureError } from './infrastructure-error';

/**
 * A message no later delivery can make processable: not a contract this build knows, a
 * message of another queue, one the broker gave up delivering. A consumer throws it, and the
 * message is parked in the dead-letter queue at once, without the retries a failure that may
 * pass gets (infrastructure/messaging/retry-or-park.ts).
 */
export class UnprocessableMessageError extends InfrastructureError {
  readonly code = 'UNPROCESSABLE_MESSAGE';
  readonly retryable = false;
}
