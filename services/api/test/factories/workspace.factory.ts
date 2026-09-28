import { faker } from '@faker-js/faker';
import { Factory } from 'fishery';

import type { Workspace } from '@infra/database/generated/prisma/client';
import { newId } from '@shared/domain/id';

import { testDb } from '../setup/db';

/** A workspace beyond acme/globex, e.g. a third tenant for an isolation test. */
export const workspaceFactory = Factory.define<Workspace>(({ sequence, onCreate }) => {
  onCreate((workspace) => testDb().workspace.create({ data: workspace }));

  const now = new Date();
  return {
    id: newId(),
    name: faker.company.name(),
    slug: `test-ws-${String(sequence)}`, // globally unique
    currency: 'EUR',
    taxRateBps: 2000,
    createdAt: now,
    updatedAt: now,
  };
});
