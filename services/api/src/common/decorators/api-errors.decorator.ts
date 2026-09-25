import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

import { ErrorResponseDto } from '../dto/error-response.dto';

const DESCRIPTIONS: Record<ErrorStatus, string> = {
  400: 'Validation failed (`VALIDATION_FAILED`) or malformed request',
  401: 'Missing, invalid or expired bearer token',
  403: 'Member of the workspace, but the role does not allow this action',
  404: 'Resource not found, or not visible to the caller',
  409: 'Conflict: duplicate or stale `version`; re-read and retry',
  422: 'Action not possible in the current state',
  502: 'Upstream error',
};

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 502;

/**
 * Documents error responses with the single `ErrorResponseDto` schema. The OpenAPI document
 * must list every status an operation can return, because Step 1 fuzzes against it.
 */
export const ApiErrors = (...statuses: ErrorStatus[]) =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, description: DESCRIPTIONS[status], type: ErrorResponseDto }),
    ),
  );
