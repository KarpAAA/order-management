import { describe, expect, it } from 'vitest';

import { systemActor, userActor } from '@shared/auth/actor';
import { WorkspaceRole } from '@shared/auth/workspace-role';
import type { WorkspaceMembership } from '@shared/auth/workspace-role';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { CatalogPolicy } from './catalog.policy';

const USER = '01990000-0000-7000-8000-000000000001';
const WORKSPACE = '01990000-0000-7000-8000-a00000000000';

/**
 * docs/requirements.md → PERM, row "Create / edit / archive products", copied by hand on
 * purpose: a table derived from PRODUCT_MANAGERS would agree with any change to it.
 */
const PERM: readonly { role: WorkspaceRole; manage: boolean }[] = [
  { role: WorkspaceRole.Viewer, manage: false },
  { role: WorkspaceRole.Member, manage: false },
  { role: WorkspaceRole.Admin, manage: true },
  { role: WorkspaceRole.Owner, manage: true },
];

const policy = new CatalogPolicy();
const user = userActor(USER);
const as = (role: WorkspaceRole): WorkspaceMembership => ({
  workspaceId: WORKSPACE,
  userId: USER,
  role,
});
const forbidden = expect.objectContaining({
  constructor: ForbiddenError,
  action: 'catalog.manage-products',
});

describe('CatalogPolicy', () => {
  it.each(PERM)('PERM-001 a $role: may manage products = $manage', ({ role, manage }) => {
    const check = (): void => {
      policy.assertCanManageProducts(user, as(role));
    };
    if (manage) expect(check).not.toThrow();
    else expect(check).toThrow(forbidden);
  });

  it('a user outside the workspace may not manage products', () => {
    expect(() => {
      policy.assertCanManageProducts(user, null);
    }).toThrow(forbidden);
  });

  it('system work never manages products, whatever membership it carries', () => {
    expect(() => {
      policy.assertCanManageProducts(systemActor('job:import'), as(WorkspaceRole.Owner));
    }).toThrow(forbidden);
  });
});
