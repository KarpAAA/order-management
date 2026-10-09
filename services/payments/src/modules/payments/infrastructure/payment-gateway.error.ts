import { InfrastructureError } from '@shared/errors/infrastructure-error';

export class PaymentGatewayError extends InfrastructureError {
  readonly code = 'PAYMENT_GATEWAY_UNAVAILABLE';
  /** How long the provider asked to be left alone (`Retry-After`), when it said so. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    readonly retryable: boolean,
    { retryAfterMs, ...options }: { cause?: unknown; retryAfterMs?: number | undefined } = {},
  ) {
    super(message, options);
    this.retryAfterMs = retryAfterMs;
  }
}
