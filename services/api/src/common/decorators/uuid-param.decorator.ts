import { Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';

/**
 * A UUID path parameter: validated by `ParseUUIDPipe` (400 otherwise) and documented as
 * `format: uuid` from the same line, so the OpenAPI document cannot drift from the check.
 * `workspaceId` is documented by `@WorkspaceScoped()` instead.
 */
export const UuidParam =
  (name: string): ParameterDecorator =>
  (target, key, index) => {
    Param(name, ParseUUIDPipe)(target, key, index);
    const method = key === undefined ? undefined : Object.getOwnPropertyDescriptor(target, key);
    if (key !== undefined && method !== undefined) {
      ApiParam({ name, format: 'uuid' })(target, key, method);
    }
  };
