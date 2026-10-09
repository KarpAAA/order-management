import { InfrastructureError } from '@shared/errors/infrastructure-error';

/**
 * The broker took the message and had no queue to put it in. For a command that is a loss:
 * its receiver has not declared its queue yet, or the routing key is wrong.
 */
export class UnroutableMessageError extends InfrastructureError {
  readonly code = 'UNROUTABLE_MESSAGE';
  // the queue appears when its reader starts
  readonly retryable = true;
}
