import { Inject, Injectable } from '@nestjs/common';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { createTransport, type Transporter } from 'nodemailer';

import { mailConfig, type MailConfig } from '@config/configuration';
import { runInTraceContext, traceCarrierFrom } from '@infra/tracing/trace-context';

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
  return new MailDeliveryError(message, !refused, {
    cause: err,
    ...(typeof code === 'number' ? { smtpCode: code } : {}),
  });
}

/**
 * The mail server over SMTP (dev and tests: Mailpit). One connection per mail, no pool: the
 * dispatcher sends one at a time, and a pooled connection that died is a failed try.
 * Every phase has the same time limit, so a server that is away costs a bounded wait.
 *
 * A send is a span, `smtp send`, in the trace of the event that asked for the mail: nodemailer
 * has no instrumentation, and without it the last step of an order shows no time of its own
 * (docs/adr/0025). The span names the server and the reply code, never the address.
 */
@Injectable()
export class SmtpMailerAdapter implements Mailer, OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;
  private readonly host: string;

  constructor(@Inject(mailConfig.KEY) config: MailConfig) {
    this.from = config.from;
    this.host = config.host;
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

  send(mail: OutgoingMail): Promise<void> {
    return runInTraceContext(traceCarrierFrom(mail.traceContext), () =>
      trace
        .getTracer('oms')
        .startActiveSpan(
          'smtp send',
          { kind: SpanKind.CLIENT, attributes: { 'server.address': this.host } },
          async (span) => {
            try {
              await this.transport.sendMail({
                from: this.from,
                to: mail.to,
                subject: mail.subject,
                text: mail.text,
                messageId: mail.messageId,
              });
            } catch (err: unknown) {
              const failure = toMailDeliveryError(err);
              if (failure.smtpCode !== undefined) {
                span.setAttribute('smtp.response.code', failure.smtpCode);
              }
              // the code says why; the text of the server names the address
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw failure;
            } finally {
              span.end();
            }
          },
        ),
    );
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
