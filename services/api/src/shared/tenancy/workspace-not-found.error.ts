import { NotFoundError } from '../errors/domain-error';

/**
 * The workspace does not exist, or the caller is not a member of it. The two cases are
 * deliberately indistinguishable: another tenant's workspace must not be revealed.
 */
export class WorkspaceNotFoundError extends NotFoundError {
  readonly code = 'WORKSPACE_NOT_FOUND';

  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} not found`, { workspaceId });
  }
}
