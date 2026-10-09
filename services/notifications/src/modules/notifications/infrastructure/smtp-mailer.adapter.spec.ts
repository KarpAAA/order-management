import { describe, expect, it } from 'vitest';

import { MailDeliveryError } from '../ports/mailer.port';

import { toMailDeliveryError } from './smtp-mailer.adapter';

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
