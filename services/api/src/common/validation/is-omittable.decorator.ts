import { ValidateIf } from 'class-validator';

/**
 * The field may be left out, but not sent as `null`. `@IsOptional()` skips validation for
 * both `undefined` and `null`, so a `null` reached the database (NOT NULL → 500). Use
 * `@IsOptional()` only where `null` is a meaningful value (e.g. "clear the description").
 */
export const IsOmittable = (): PropertyDecorator =>
  ValidateIf((_object: object, value: unknown) => value !== undefined);
