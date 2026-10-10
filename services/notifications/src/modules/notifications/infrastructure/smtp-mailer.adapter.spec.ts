import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';

import type { MailConfig } from '@config/configuration';

import { MailDeliveryError } from '../ports/mailer.port';

import { SmtpMailerAdapter, toMailDeliveryError } from './smtp-mailer.adapter';

describe('SmtpMailerAdapter: a send is a span (docs/adr/0025)', () => {
  it('TRC-040 names the server and how it ended, never the address', async () => {
    const exporter = new InMemorySpanExporter();
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    // nobody listens there: the connection is refused at once
    const config = { host: '127.0.0.1', port: 1, secure: false, from: 'oms@example.test' };
    const mailer = new SmtpMailerAdapter({ ...config, timeoutMs: 2000 } as MailConfig);

    await expect(
      mailer.send({ to: 'user@example.test', subject: 's', text: 't', messageId: '<m@oms>' }),
    ).rejects.toBeInstanceOf(MailDeliveryError);

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('smtp send');
    expect(span?.attributes).toEqual({ 'server.address': '127.0.0.1' });
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(span?.attributes)).not.toContain('user@example.test');
  });
});

/** An error as nodemailer throws it for an SMTP reply. */
const reply = (responseCode: number, message: string): Error =>
  Object.assign(new Error(message), { code: 'EENVELOPE', responseCode });

describe('toMailDeliveryError', () => {
  it.each([
    [550, 'no such user here'],
    [553, 'mailbox name not allowed'],
    [501, 'bad address syntax'],
  ])('NTF-013 a reply %i is a refusal: another try will not help', (code, message) => {
    const error = toMailDeliveryError(reply(code, message));

    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(message);
  });

  it.each([
    [421, 'service not available'],
    [450, 'mailbox busy'],
    [451, 'local error in processing'],
  ])('NTF-011 a reply %i may pass later', (code, message) => {
    expect(toMailDeliveryError(reply(code, message)).retryable).toBe(true);
  });

  it.each([
    ['a refused connection', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET' })],
    ['a timeout', Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' })],
    ['something that is not an error', 'socket closed'],
  ])('NTF-011 %s may pass later', (_case, cause) => {
    const error = toMailDeliveryError(cause);

    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });
});
