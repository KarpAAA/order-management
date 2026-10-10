import { NestLoggerAdapter } from '../logger/nest-logger.adapter';

const HANDLER_THREW = 'Error processing message on handler';

/**
 * The logger the broker library writes through. It reports a handler that threw as an error
 * of its own, before it asks what to do with the message: that delivery already has its line,
 * a `warn` for one that comes again and an `error` for one that is parked
 * (`retry-or-park.ts`). Written at `error` as well, every retry would be an error and every
 * parked message two. Its line stays, at `debug`.
 */
export class LibraryLogger extends NestLoggerAdapter {
  override error(message: unknown, ...params: unknown[]): void {
    if (typeof message === 'string' && message.startsWith(HANDLER_THREW)) {
      this.debug(message, ...params);
      return;
    }
    super.error(message, ...params);
  }
}
