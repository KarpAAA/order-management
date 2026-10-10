import { Catch, HttpException, HttpStatus, Inject } from '@nestjs/common';

import { AuthenticationError } from '@shared/errors/authentication-error';
import {
  ConflictError,
  DomainError,
  InvalidStateError,
  NotFoundError,
} from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';
import { IdempotencyKeyInProgressError } from '@shared/errors/idempotency-key.error';
import { InfrastructureError } from '@shared/errors/infrastructure-error';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { VALIDATION_FAILED } from '../validation/validation-exception.factory';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface Mapped {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
};

const domain = (status: number, err: DomainError): Mapped => ({
  status,
  body: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
});

/**
 * One global filter, one response format. Maps by base class, most specific first.
 *
 * It is where an error of a request is logged, once (ops/logging.md §3): a 5xx at `error`
 * with the error itself, a 4xx at `warn` with its code and nothing a client sent.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly log: Logger;

  constructor(@Inject(LOGGER) logger: Logger) {
    this.log = logger.child({ context: AppExceptionFilter.name });
  }

  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const { status, body, headers } = this.map(err);

    if (status >= 500) {
      this.log.error({ code: body.code, status, err }, 'request failed');
    } else {
      this.log.warn(clientError(err, status, body, http.getRequest<Request>()), 'request refused');
    }

    res
      .status(status)
      .set(headers ?? {})
      .json(body);
  }

  private map(err: unknown): Mapped {
    if (err instanceof IdempotencyKeyInProgressError) {
      // the first request with the key is about to be answered: the same key, a moment later
      return { ...domain(409, err), headers: { 'Retry-After': '1' } };
    }
    if (err instanceof NotFoundError) return domain(404, err);
    if (err instanceof ConflictError) return domain(409, err);
    if (err instanceof InvalidStateError) return domain(422, err);
    if (err instanceof DomainError) return domain(400, err);
    if (err instanceof AuthenticationError) {
      return { status: 401, body: { code: err.code, message: err.message } };
    }
    if (err instanceof ForbiddenError) {
      return { status: 403, body: { code: 'FORBIDDEN', message: 'Forbidden' } };
    }
    if (err instanceof InfrastructureError) {
      return err.retryable
        ? {
            status: 503,
            body: { code: err.code, message: 'Upstream unavailable' },
            headers: { 'Retry-After': '5' },
          }
        : { status: 502, body: { code: err.code, message: 'Upstream error' } };
    }
    if (err instanceof HttpException) return this.fromNest(err);
    const clientError = asClientHttpError(err);
    if (clientError) return clientError;
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL', message: 'Internal error' },
    };
  }

  private fromNest(err: HttpException): Mapped {
    const status = err.getStatus();
    const response = err.getResponse();
    if (isErrorBody(response) && response.code === VALIDATION_FAILED) {
      return { status, body: response };
    }
    const message =
      typeof response === 'object' && 'message' in response && typeof response.message === 'string'
        ? response.message
        : err.message;
    return {
      status,
      body: {
        code: CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL' : 'HTTP_ERROR'),
        message,
      },
    };
  }
}

/**
 * 4xx at warn with the code (http/error-handling.md §2). Only what is safe to log: field paths
 * of a validation failure (never values), the policy action of a 403, the IP of a failed login
 * (ops/security.md §3) — never the email or the password.
 */
function clientError(err: unknown, status: number, body: ErrorBody, req: Request): object {
  const line = { code: body.code, status };
  if (err instanceof AuthenticationError) return { ...line, ip: req.ip ?? 'unknown' };
  if (err instanceof ForbiddenError) return { ...line, action: err.action };
  if (body.code === VALIDATION_FAILED) return { ...line, fields: [...new Set(fieldPaths(body))] };
  return line;
}

function fieldPaths(body: ErrorBody): string[] {
  const fields = body.details?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((f: unknown) =>
    typeof f === 'object' && f !== null && 'path' in f && typeof f.path === 'string'
      ? [f.path]
      : [],
  );
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

/** Errors from Express middleware (e.g. malformed JSON, body too large) use `http-errors`. */
function asClientHttpError(err: unknown): Mapped | null {
  if (typeof err !== 'object' || err === null || !('status' in err) || !('expose' in err)) {
    return null;
  }
  const { status, expose } = err;
  if (typeof status !== 'number' || status < 400 || status >= 500 || expose !== true) return null;
  const message = 'message' in err && typeof err.message === 'string' ? err.message : 'Bad request';
  return { status, body: { code: CODE_BY_STATUS[status] ?? 'BAD_REQUEST', message } };
}
