import { InfrastructureError } from '@shared/errors/infrastructure-error';

export class PaymentGatewayError extends InfrastructureError {
  readonly code = 'PAYMENT_GATEWAY_UNAVAILABLE';

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
