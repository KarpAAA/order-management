import { Inject, Injectable } from '@nestjs/common';

import { MEMBERSHIP_READER, type MembershipReader } from '@shared/tenancy/membership-reader';
import { WorkspaceNotFoundError } from '@shared/tenancy/workspace-not-found.error';

import { TenantContext } from '../tenancy/tenant-context';

import type { RequestWithActor } from '../decorators/current-actor.decorator';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs after the global `AuthGuard` on every `/workspaces/:workspaceId/…` route.
 * Resolves the caller's membership; a non-member gets 404, never 403, so another tenant's
 * workspace cannot be discovered. On success it binds the tenant context for the request.
 * Permission checks (403) are the policies' job, not this guard's.
 */
@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(
    @Inject(MEMBERSHIP_READER) private readonly memberships: MembershipReader,
    private readonly tenant: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const workspaceId = request.params.workspaceId;
    const actor = request.actor;
    if (!actor || typeof workspaceId !== 'string') return false;
    if (!UUID.test(workspaceId)) throw new WorkspaceNotFoundError(workspaceId);

    const membership = await this.memberships.findMembership(workspaceId, actor.userId);
    if (!membership) throw new WorkspaceNotFoundError(workspaceId);

    this.tenant.enter(membership);
    return true;
  }
}
