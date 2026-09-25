import { BadRequestException } from '@nestjs/common';

import type { ValidationError } from 'class-validator';

export const VALIDATION_FAILED = 'VALIDATION_FAILED';

interface FieldError {
  path: string;
  code: string;
  message: string;
}

function flatten(errors: readonly ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.entries(error.constraints ?? {}).map(([code, message]) => ({
      path,
      code,
      message,
    }));
    return [...own, ...flatten(error.children ?? [], path)];
  });
}

/** `ValidationPipe` → one flat `fields` list in the standard error shape. */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  return new BadRequestException({
    code: VALIDATION_FAILED,
    message: 'Request validation failed',
    details: { fields: flatten(errors) },
  });
}
