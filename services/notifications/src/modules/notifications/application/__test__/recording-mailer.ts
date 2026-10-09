import type { Mailer, OutgoingMail } from '../../ports/mailer.port';

/** Fake: remembers what it was handed, and fails as long as it is told to. */
export class RecordingMailer implements Mailer {
  /** Everything that was tried, whether the server "took" it or not. */
  readonly tried: OutgoingMail[] = [];
  readonly sent: OutgoingMail[] = [];
  private failure: unknown;

  /** Every send from now on throws `error`; `undefined` makes it work again. */
  failWith(error: unknown): void {
    this.failure = error;
  }

  send(mail: OutgoingMail): Promise<void> {
    this.tried.push(mail);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- whatever an adapter may throw
    if (this.failure !== undefined) return Promise.reject(this.failure);
    this.sent.push(mail);
    return Promise.resolve();
  }
}
