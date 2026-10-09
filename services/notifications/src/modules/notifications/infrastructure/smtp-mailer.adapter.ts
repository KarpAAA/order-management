import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { mailConfig, type MailConfig } from '@config/configuration';

import { MailDeliveryError, type Mailer, type OutgoingMail } from '../ports/mailer.port';

import type { OnModuleDestroy } from '@nestjs/common';

/** The first digit of an SMTP reply: 4 = try again later, 5 = no, and asking again will not help. */
const PERMANENT_FAILURE = 500;

/**
 * What a failed send means for the next try. An SMTP reply of class 5 is the server's
 * refusal of this mail. Everything else may pass: a reply of class 4, a connection that
 * was refused or timed out, a server that hung up.
 */
export function toMailDeliveryError(err: unknown): MailDeliveryError {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === 'object' && err !== null && 'responseCode' in err ? err.responseCode : undefined;
  const refused = typeof code === 'number' && code >= PERMANENT_FAILURE;
  return new MailDeliveryError(message, !refused, { cause: err });
}

/**
 * The mail server over SMTP (dev and tests: Mailpit). One connection per mail, no pool: the
 * dispatcher sends one at a time, and a pooled connection that died is a failed try.
 * Every phase has the same time limit, so a server that is away costs a bounded wait.
 */
@Injectable()
export class SmtpMailerAdapter implements Mailer, OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(mailConfig.KEY) config: MailConfig) {
    this.from = config.from;
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.auth ? { auth: config.auth } : {}),
      connectionTimeout: config.timeoutMs,
      greetingTimeout: config.timeoutMs,
      socketTimeout: config.timeoutMs,
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        messageId: mail.messageId,
      });
    } catch (err: unknown) {
      throw toMailDeliveryError(err);
    }
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
