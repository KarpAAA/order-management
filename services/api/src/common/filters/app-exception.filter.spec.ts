import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AuthenticationError } from '@shared/errors/authentication-error';
import { NotFoundError } from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';
import { RecordingLogger } from '@shared/logger/__test__/recording-logger';

import { validationExceptionFactory } from '../validation/validation-exception.factory';

import { AppExceptionFilter } from './app-exception.filter';

import type { ArgumentsHost } from '@nestjs/common';

class OrderNotFound extends NotFoundError {
  readonly code = 'ORDER_NOT_FOUND';
}

const IP = '203.0.113.7';

/** A host whose response records the status; the request carries only an IP. */
function hostFor(): { host: ArgumentsHost; status: () => number | undefined } {
  let status: number | undefined;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    set: () => res,
    json: () => res,
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ ip: IP }) }),
  } as unknown as ArgumentsHost;
  return { host, status: () => status };
}

describe('AppExceptionFilter logging (http/error-handling.md §2, ops/security.md §3)', () => {
  /** Runs the filter on `err`; what it logged is the fields of each line, by level. */
  function caught(err: unknown) {
    const logger = new RecordingLogger();
    const { host, status } = hostFor();
    new AppExceptionFilter(logger).catch(err, host);
    // without the name of the class, which every line of the filter carries
    const fields = (level: 'warn' | 'error') =>
      logger
        .at(level)
        .map((line) =>
          Object.fromEntries(Object.entries(line.fields).filter(([key]) => key !== 'context')),
        );
    return {
      status: status(),
      warned: fields('warn'),
      failed: fields('error'),
      lines: logger.lines,
    };
  }

  it('logs a failed login at warn with the IP, never the credentials', () => {
    const { status, warned } = caught(new AuthenticationError());

    expect(status).toBe(401);
    expect(warned).toEqual([{ code: 'INVALID_CREDENTIALS', status: 401, ip: IP }]);
  });

  it('logs every other 4xx at warn with its code', () => {
    const { warned, failed } = caught(new OrderNotFound('order o-1 not found'));

    expect(warned).toEqual([{ code: 'ORDER_NOT_FOUND', status: 404 }]);
    expect(failed).toEqual([]);
  });

  it('logs a validation failure with the field paths, not the values', () => {
    const err = validationExceptionFactory([
      { property: 'email', constraints: { isEmail: 'email must be an email' }, children: [] },
    ]);

    expect(caught(err).warned).toEqual([
      { code: 'VALIDATION_FAILED', status: 400, fields: ['email'] },
    ]);
  });

  it('keeps the policy action on a 403', () => {
    expect(caught(new ForbiddenError('orders.cancel')).warned).toEqual([
      { code: 'FORBIDDEN', status: 403, action: 'orders.cancel' },
    ]);
  });

  it('logs a 5xx at error with the error itself, not at warn', () => {
    const boom = new Error('boom');
    const { status, warned, failed } = caught(boom);

    expect(status).toBe(500);
    expect(failed).toEqual([{ code: 'INTERNAL', status: 500, err: boom }]);
    expect(warned).toEqual([]);
  });

  it('logs a plain Nest 4xx with the mapped code', () => {
    expect(caught(new BadRequestException('bad')).warned).toEqual([
      { code: 'BAD_REQUEST', status: 400 },
    ]);
  });

  it('says the same thing every time: the message of a line carries no value (LOG-003)', () => {
    const { lines } = caught(new OrderNotFound('order o-1 not found'));

    expect(lines.map((line) => line.message)).toEqual(['request refused']);
  });
});
