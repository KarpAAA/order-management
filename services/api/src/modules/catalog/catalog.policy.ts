import { Injectable } from '@nestjs/common';

import type { Actor } from '@shared/auth/actor';
import { hasAnyRole, WorkspaceRole } from '@shared/auth/workspace-role';
import type { WorkspaceMembership } from '@shared/auth/workspace-role';
import { ForbiddenError } from '@shared/errors/forbidden-error';

const PRODUCT_MANAGERS = [WorkspaceRole.Owner, WorkspaceRole.Admin] as const;

/** Reading the catalog needs only membership (verified by the access guard). */
@Injectable()
export class CatalogPolicy {
  assertCanManageProducts(actor: Actor, membership: WorkspaceMembership | null): void {
    if (actor.kind === 'user' && hasAnyRole(membership, PRODUCT_MANAGERS)) return;
    throw new ForbiddenError('catalog.manage-products');
  }
}
