import { ConflictError, NotFoundError } from '@shared/errors/domain-error';

export class EmailAlreadyRegisteredError extends ConflictError {
  readonly code = 'EMAIL_ALREADY_REGISTERED';

  constructor() {
    super('This email is already registered');
  }
}

export class WorkspaceSlugTakenError extends ConflictError {
  readonly code = 'WORKSPACE_SLUG_TAKEN';

  constructor(slug: string) {
    super(`Workspace slug "${slug}" is taken`, { slug });
  }
}

export class UserNotFoundError extends NotFoundError {
  readonly code = 'USER_NOT_FOUND';

  constructor() {
    super('User not found');
  }
}

export class AlreadyMemberError extends ConflictError {
  readonly code = 'ALREADY_MEMBER';

  constructor(userId: string) {
    super('The user is already a member of this workspace', { userId });
  }
}
