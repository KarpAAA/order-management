/**
 * What never reaches a log line, whatever object it came in (ops/logging.md §5): secrets, and
 * the address of a person. A safety net, not the rule: the rule is that nobody logs a body, a
 * payload or a header (the same section). pino matches a path, not a key at any depth, so a
 * key is listed at the three depths a logged object has here: a field, a field of a field
 * (`err.details`, `headers`), and one below.
 */
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'secret',
  'apiKey',
  'email',
  'recipientEmail',
];

// a key with a dash is not an identifier: it is addressed with brackets
const segment = (key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`);
const under = (prefix: string, key: string): string =>
  segment(key).startsWith('[') ? `${prefix}${segment(key)}` : `${prefix}.${key}`;

export const REDACTED_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => [
  segment(key),
  under('*', key),
  under('*.*', key),
]);

export const REDACTED = '[redacted]';
