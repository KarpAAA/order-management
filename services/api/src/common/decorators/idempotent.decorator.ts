import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';

import { IDEMPOTENCY_KEY_HEADER } from '@shared/errors/idempotency-key.error';

import { IdempotencyInterceptor } from '../interceptors/idempotency.interceptor';

import { ApiErrors } from './api-errors.decorator';

/**
 * Method decorator for a write that must not happen twice when its client retries: the route
 * requires an `Idempotency-Key` and answers a repeated key with the first answer
 * (`IdempotencyInterceptor`). For a write with no natural key of its own to refuse the
 * second attempt, and for one that moves money (http/api-conventions.md §5).
 */
export const Idempotent = () =>
  applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: true,
      description:
        'A uuid chosen by the client, the same on every retry of this request. A repeated ' +
        'key returns the first response; with another body it is refused (422).',
      schema: { type: 'string', format: 'uuid' },
    }),
    // 400 no key, 409 the first request is still being handled, 422 the key was used otherwise
    ApiErrors(400, 409, 422),
  );
