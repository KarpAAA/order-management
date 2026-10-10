import { Inject, Injectable } from '@nestjs/common';

import { LOGGER, type Logger } from '@shared/logger/logger';

import type { LoggerService } from '@nestjs/common';

type Level = 'debug' | 'info' | 'warn' | 'error';

/** What a stack looks like: a line that says where, after the first. */
const STACK = /\n\s+at .+:\d+:\d+/;

/**
 * What Nest and the libraries that take a Nest logger (the broker connection) write through:
 * `app.useLogger()` in the entrypoints. Their lines keep their text as the message, with the
 * name they gave as `context`. Our own code never logs through this: it injects `LOGGER`.
 */
@Injectable()
export class NestLoggerAdapter implements LoggerService {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  /**
   * `(message, stack?, context?)`: the last string names the context, one before it is a
   * stack. A library may give the stack alone (`error(message, err.stack)`): what looks like
   * a stack is one, wherever it stands.
   */
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    const strings = params.filter((param): param is string => typeof param === 'string');
    const trace = strings.find((param) => STACK.test(param));
    const names = strings.filter((param) => param !== trace);
    const context = names.at(-1);
    const stack = trace ?? (level === 'error' && names.length > 1 ? names[0] : undefined);
    const fields = {
      ...(context === undefined ? {} : { context }),
      ...(message instanceof Error ? { err: message } : {}),
      ...(stack === undefined ? {} : { stack }),
    };
    this.logger[level](fields, message instanceof Error ? message.message : text(message));
  }
}

function text(message: unknown): string {
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}
