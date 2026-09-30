import { describe, expect, it } from 'vitest';

import { systemActor, userActor } from '@shared/auth/actor';
import { WorkspaceRole } from '@shared/auth/workspace-role';
import type { WorkspaceMembership } from '@shared/auth/workspace-role';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { IdentityPolicy } from './identity.policy';

const USER = '01990000-0000-7000-8000-000000000001';
const WORKSPACE = '01990000-0000-7000-8000-a00000000000';
const { Viewer, Member, Admin, Owner } = WorkspaceRole;

/**
 * docs/requirements.md → PERM, rows "Add member with role …", copied by hand on purpose:
 * the roles each caller may grant.
 */
const PERM: readonly { role: WorkspaceRole; mayGrant: readonly WorkspaceRole[] }[] = [
  { role: Viewer, mayGrant: [] },
  { role: Member, mayGrant: [] },
  { role: Admin, mayGrant: [Member, Viewer] },
  { role: Owner, mayGrant: [Viewer, Member, Admin, Owner] },
];
const ALL_ROLES = [Viewer, Member, Admin, Owner] as const;

const policy = new IdentityPolicy();
const user = userActor(USER);
const as = (role: WorkspaceRole): WorkspaceMembership => ({
  workspaceId: WORKSPACE,
  userId: USER,
  role,
});
const forbidden = expect.objectContaining({
  constructor: ForbiddenError,
  action: 'identity.add-member',
});

describe('IdentityPolicy', () => {
  describe.each(PERM)('PERM-001 a $role', ({ role, mayGrant }) => {
    it.each(ALL_ROLES)('adding a %s', (granted) => {
      const check = (): void => {
        policy.assertCanAddMember(user, as(role), granted);
      };
      if (mayGrant.includes(granted)) expect(check).not.toThrow();
      else expect(check).toThrow(forbidden);
    });
  });

  it('a user outside the workspace may not add members', () => {
    expect(() => {
      policy.assertCanAddMember(user, null, Viewer);
    }).toThrow(forbidden);
  });

  it('system work never adds members, whatever membership it carries', () => {
    expect(() => {
      policy.assertCanAddMember(systemActor('job:import'), as(Owner), Viewer);
    }).toThrow(forbidden);
  });
});
