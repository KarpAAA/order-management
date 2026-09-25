import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import type { WorkspaceMembership } from '@shared/auth/workspace-role';

const WORKSPACE_ID = Symbol('tenant.workspaceId');
const MEMBERSHIP = Symbol('tenant.membership');

/**
 * The tenant of the current request or job, held in CLS. Written in exactly two places —
 * the workspace access guard (HTTP) and `runInWorkspace` (worker) — and read by the tenant
 * scope in `infrastructure/database/`, which fails closed when it is missing.
 */
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService) {}

  /** `undefined` outside a tenant scope; the database layer turns that into an error. */
  workspaceId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string | undefined>(WORKSPACE_ID) : undefined;
  }

  /** The caller's membership, or `null` for system work (jobs) and non-workspace routes. */
  membership(): WorkspaceMembership | null {
    if (!this.cls.isActive()) return null;
    return this.cls.get<WorkspaceMembership | undefined>(MEMBERSHIP) ?? null;
  }

  /** HTTP: called by the guard once membership is verified. */
  enter(membership: WorkspaceMembership): void {
    this.cls.set(WORKSPACE_ID, membership.workspaceId);
    this.cls.set(MEMBERSHIP, membership);
  }

  /** Worker: runs `work` in a fresh CLS scope bound to `workspaceId`, with no membership. */
  runInWorkspace<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    return this.cls.run(() => {
      this.cls.set(WORKSPACE_ID, workspaceId);
      return work();
    });
  }
}
