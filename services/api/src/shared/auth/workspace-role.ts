/** Mirrors the Prisma enum `WorkspaceRole` one-to-one. */
export enum WorkspaceRole {
  Owner = 'OWNER',
  Admin = 'ADMIN',
  Member = 'MEMBER',
  Viewer = 'VIEWER',
}

/** The caller's membership in the workspace of the current request. */
export interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
}

export const hasAnyRole = (
  membership: WorkspaceMembership | null,
  roles: readonly WorkspaceRole[],
): membership is WorkspaceMembership => membership !== null && roles.includes(membership.role);
