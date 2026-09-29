import { Factory } from 'fishery';

import type { Membership } from '@infra/database/generated/prisma/client';
import { newId } from '@shared/domain/id';

import { WS_ACME } from '../seed/ids';
import { testDb } from '../setup/db';

/** A user's role in a workspace. `userId` is required: there is no sensible default user. */
export const membershipFactory = Factory.define<Membership>(({ onCreate }) => {
  onCreate((membership) => {
    if (!membership.userId) throw new Error('membershipFactory: pass { userId }');
    return testDb().membership.create({ data: membership });
  });

  const now = new Date();
  return {
    workspaceId: WS_ACME,
    id: newId(),
    userId: '',
    role: 'MEMBER',
    createdAt: now,
    updatedAt: now,
  };
});
