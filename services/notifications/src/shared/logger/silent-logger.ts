import type { Logger } from './logger';

const nothing = (): void => undefined;

/** A logger that writes nothing: for a script or a test that builds a class by hand. */
export const silentLogger: Logger = {
  debug: nothing,
  info: nothing,
  warn: nothing,
  error: nothing,
  child: () => silentLogger,
};
