import type { WorkspaceMembership } from '../auth/workspace-role';

export const MEMBERSHIP_READER = Symbol('MEMBERSHIP_READER');

/**
 * Resolves a user's membership in a workspace. Implemented by the identity module's facade
 * and consumed by the workspace access guard in `common/`, so the guard never reaches into
 * identity's tables.
 */
export interface MembershipReader {
  findMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
}
