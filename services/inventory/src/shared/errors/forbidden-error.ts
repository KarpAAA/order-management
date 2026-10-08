/** Policy said no → 403, generic body. `action` is `<module>.<verb>` for audit and tests. */
export class ForbiddenError extends Error {
  constructor(
    readonly action: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`Forbidden: ${action}`);
    this.name = new.target.name;
  }
}
