import { BadRequestException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthenticationError } from '@shared/errors/authentication-error';
import { NotFoundError } from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const spyLogs = () => ({
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  });

  it('logs a failed login at warn with the IP, never the credentials', () => {
    const { warn } = spyLogs();
    const { host, status } = hostFor();

    new AppExceptionFilter().catch(new AuthenticationError(), host);

    expect(status()).toBe(401);
    expect(warn).toHaveBeenCalledWith(`INVALID_CREDENTIALS status=401 ip=${IP}`);
  });

  it('logs every other 4xx at warn with its code', () => {
    const { warn, error } = spyLogs();
    const { host } = hostFor();

    new AppExceptionFilter().catch(new OrderNotFound('order o-1 not found'), host);

    expect(warn).toHaveBeenCalledWith('ORDER_NOT_FOUND status=404');
    expect(error).not.toHaveBeenCalled();
  });

  it('logs a validation failure with the field paths, not the values', () => {
    const { warn } = spyLogs();
    const { host } = hostFor();
    const err = validationExceptionFactory([
      { property: 'email', constraints: { isEmail: 'email must be an email' }, children: [] },
    ]);

    new AppExceptionFilter().catch(err, host);

    expect(warn).toHaveBeenCalledWith('VALIDATION_FAILED status=400 fields=email');
  });

  it('keeps the policy action on a 403', () => {
    const { warn } = spyLogs();
    const { host } = hostFor();

    new AppExceptionFilter().catch(new ForbiddenError('orders.cancel'), host);

    expect(warn).toHaveBeenCalledWith('FORBIDDEN status=403 action=orders.cancel');
  });

  it('logs a 5xx at error, not at warn', () => {
    const { warn, error } = spyLogs();
    const { host, status } = hostFor();

    new AppExceptionFilter().catch(new Error('boom'), host);

    expect(status()).toBe(500);
    expect(error).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a plain Nest 4xx with the mapped code', () => {
    const { warn } = spyLogs();
    const { host } = hostFor();

    new AppExceptionFilter().catch(new BadRequestException('bad'), host);

    expect(warn).toHaveBeenCalledWith('BAD_REQUEST status=400');
  });
});
