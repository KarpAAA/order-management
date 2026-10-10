import { InfrastructureError } from '@shared/errors/infrastructure-error';

export const MAILER = Symbol('MAILER');

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /**
   * The same for every try of one notification. A mail server has no idempotency key; this
   * is what a reader's mail client, or a provider that looks, can recognize a repetition by.
   */
  messageId: string;
}

/**
 * The mail did not leave. `retryable`: the server was away or busy, and another try may
 * work. Not retryable: it answered and said no (an address it does not accept).
 */
export class MailDeliveryError extends InfrastructureError {
  readonly code = 'MAIL_DELIVERY_FAILED';

  /** The reply code of the server (550, 421), when it answered. */
  readonly smtpCode: number | undefined;

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; smtpCode?: number },
  ) {
    super(message, options);
    this.smtpCode = options?.smtpCode;
  }
}

/**
 * "Hand this mail to the mail server." Resolves when the server took it; whatever happens to
 * it afterwards is not known here. Throws `MailDeliveryError` otherwise, within a bounded
 * time: the caller holds a row of the database while it waits.
 */
export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}
