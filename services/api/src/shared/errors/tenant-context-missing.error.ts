/**
 * A tenant-scoped table was touched without a tenant in context. Always a bug in the
 * calling code (a missing guard or a job that did not set the workspace), so it is a
 * plain Error and becomes a 500: tenant isolation fails closed.
 */
export class TenantContextMissingError extends Error {
  constructor(model: string, operation: string) {
    super(`No tenant in context for ${model}.${operation}`);
    this.name = new.target.name;
  }
}

/** Data carries a workspace that differs from the one in context. Also always a bug. */
export class TenantMismatchError extends Error {
  constructor(model: string, operation: string) {
    super(`Workspace in data does not match the tenant in context for ${model}.${operation}`);
    this.name = new.target.name;
  }
}
