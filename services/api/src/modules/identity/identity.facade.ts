import { Injectable } from '@nestjs/common';

import type { WorkspaceMembership } from '@shared/auth/workspace-role';
import type { MembershipReader } from '@shared/tenancy/membership-reader';

import { IdentityQueryService } from './read/identity.query.service';

export interface WorkspaceTerms {
  currency: string;
  taxRateBps: number;
}

/** Public API of identity: reads other modules and the access guard need. */
@Injectable()
export class IdentityFacade implements MembershipReader {
  constructor(private readonly query: IdentityQueryService) {}

  /** The caller's membership in a workspace, or `null` when not a member. */
  findMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    return this.query.findMembership(workspaceId, userId);
  }

  /** Commercial terms an order snapshots at creation. */
  getWorkspaceTerms(workspaceId: string): Promise<WorkspaceTerms> {
    return this.query.getWorkspaceTerms(workspaceId);
  }
}
