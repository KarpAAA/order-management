// The identity world shared by the dev seed and the test seed (test/seed/seed-test.ts):
// workspaces, users and memberships with the fixed ids from seed-data.ts. Idempotent.
import * as argon2 from 'argon2';

import { MEMBERSHIPS, PASSWORD, seedId, USERS, WORKSPACES } from './seed-data';

import type { PrismaClient } from '../src/infrastructure/database/generated/prisma/client';

export async function seedIdentity(prisma: PrismaClient): Promise<void> {
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  for (const user of Object.values(USERS)) {
    await prisma.user.upsert({
      where: { id: user.id },
      create: { id: user.id, email: user.email, passwordHash },
      update: {},
    });
  }
  for (const { id, name, slug, currency, taxRateBps } of Object.values(WORKSPACES)) {
    await prisma.workspace.upsert({
      where: { id },
      create: { id, name, slug, currency, taxRateBps },
      update: {},
    });
  }
  await prisma.membership.createMany({
    data: MEMBERSHIPS.map((m) => ({
      workspaceId: WORKSPACES[m.ws].id,
      id: seedId(`${WORKSPACES[m.ws].group}0`, 0x100 + m.n),
      userId: USERS[m.user].id,
      role: m.role,
    })),
    skipDuplicates: true,
  });
}
