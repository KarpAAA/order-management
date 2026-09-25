import { Injectable } from '@nestjs/common';

import type { Actor } from '@shared/auth/actor';
import { hasAnyRole, WorkspaceRole } from '@shared/auth/workspace-role';
import type { WorkspaceMembership } from '@shared/auth/workspace-role';
import { ForbiddenError } from '@shared/errors/forbidden-error';

const ROLES_AN_ADMIN_MAY_GRANT: readonly WorkspaceRole[] = [
  WorkspaceRole.Member,
  WorkspaceRole.Viewer,
];

/**
 * Who may manage workspace membership. Reading the workspace and its members needs only
 * membership, which the workspace access guard has already verified (404 otherwise).
 */
@Injectable()
export class IdentityPolicy {
  assertCanAddMember(
    actor: Actor,
    membership: WorkspaceMembership | null,
    grantedRole: WorkspaceRole,
  ): void {
    if (actor.kind === 'user') {
      if (hasAnyRole(membership, [WorkspaceRole.Owner])) return;
      if (
        hasAnyRole(membership, [WorkspaceRole.Admin]) &&
        ROLES_AN_ADMIN_MAY_GRANT.includes(grantedRole)
      ) {
        return;
      }
    }
    throw new ForbiddenError('identity.add-member', { role: grantedRole });
  }
}
