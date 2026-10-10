import { pino } from 'pino';

import type { LoggingConfig } from '@config/configuration';
import type { Logger } from '@shared/logger/logger';

import { REDACTED, REDACTED_PATHS } from './redaction';

import type { DestinationStream, Logger as Pino } from 'pino';

export interface PinoLoggerOptions {
  config: LoggingConfig;
  /** On every line: which service wrote it, and which of its processes. */
  base: { service: string; process?: string };
  /** The correlation id of the work under way, read for every line. */
  correlationId: () => string | undefined;
  destination: DestinationStream;
}

/** Where the lines go: JSON on stdout, or pino-pretty for a terminal (`LOG_PRETTY`). */
export function logDestination(config: LoggingConfig): DestinationStream {
  if (!config.pretty) return pino.destination({ fd: 1, sync: true });
  // resolved only here: pino-pretty is a development dependency (env.schema.ts)
  return pino.transport({
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
  });
}

/** The pino behind `LOGGER`: one per process, every other logger is a child of it. */
export function createPinoLogger(options: PinoLoggerOptions): Logger {
  const { config, base, correlationId, destination } = options;
  const root = pino(
    {
      level: config.level,
      base,
      // the name of the level, not its number: what a query of the logs filters by
      formatters: { level: (label) => ({ level: label }) },
      timestamp: pino.stdTimeFunctions.isoTime,
      // from CLS, on every line: application code never passes it (ops/logging.md §1)
      mixin: () => {
        const id = correlationId();
        return id === undefined ? {} : { correlationId: id };
      },
      redact: { paths: REDACTED_PATHS, censor: REDACTED },
    },
    destination,
  );
  return new PinoLogger(root);
}

class PinoLogger implements Logger {
  constructor(private readonly pino: Pino) {}

  debug(fields: object, message: string): void {
    this.pino.debug(fields, message);
  }

  info(fields: object, message: string): void {
    this.pino.info(fields, message);
  }

  warn(fields: object, message: string): void {
    this.pino.warn(fields, message);
  }

  error(fields: object, message: string): void {
    this.pino.error(fields, message);
  }

  child(bindings: object): Logger {
    return new PinoLogger(this.pino.child(bindings));
  }
}
