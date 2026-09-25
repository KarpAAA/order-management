import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';

import { AuthenticationError } from '@shared/errors/authentication-error';
import {
  ConflictError,
  DomainError,
  InvalidStateError,
  NotFoundError,
} from '@shared/errors/domain-error';
import { ForbiddenError } from '@shared/errors/forbidden-error';
import { InfrastructureError } from '@shared/errors/infrastructure-error';

import { VALIDATION_FAILED } from '../validation/validation-exception.factory';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

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

/** One global filter, one response format. Maps by base class, most specific first. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = this.map(err);

    if (status >= 500) {
      this.logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    } else if (err instanceof ForbiddenError) {
      this.logger.warn(`${body.code} action=${err.action}`);
    }

    res
      .status(status)
      .set(headers ?? {})
      .json(body);
  }

  private map(err: unknown): Mapped {
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
