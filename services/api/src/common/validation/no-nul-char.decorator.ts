import { ValidateBy } from 'class-validator';

/** For `@ApiProperty({ pattern })`, so the OpenAPI document says what the API validates. */
export const NO_NUL_PATTERN = '^[^\\u0000]*$';

/**
 * Free text must not contain U+0000. JSON allows it, but PostgreSQL `text` cannot store it:
 * the write failed with 22021 (a 500). Every free-text field that reaches the database
 * carries this decorator and `pattern: NO_NUL_PATTERN`.
 */
export const NoNulChar = (): PropertyDecorator =>
  ValidateBy({
    name: 'noNulChar',
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || !value.includes('\u0000'),
      defaultMessage: () => '$property must not contain the NUL character',
    },
  });
