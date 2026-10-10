/**
 * The one logger of the service (ops/logging.md §1). A line is data: the fields first, for a
 * machine, then a message that is the same every time, for a human. The correlation id is
 * added by the implementation; nobody passes it.
 */
export interface Logger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  /** An error goes under `err`, so its name, message, stack and code are serialized. */
  error(fields: object, message: string): void;
  /** A logger that adds `bindings` to every line: `logger.child({ context: Foo.name })`. */
  child(bindings: object): Logger;
}

export const LOGGER = Symbol('LOGGER');
