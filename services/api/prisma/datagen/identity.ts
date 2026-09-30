// Workspaces, users and memberships of the generated tenants. Small volumes: Prisma createMany.
import * as argon2 from 'argon2';

import { PASSWORD } from '../seed-data';

import { DAY } from './random';

import type { TenantPlan } from './plan';
import type { Rng } from './random';
import type {
  PrismaClient,
  WorkspaceRole,
} from '../../src/infrastructure/database/generated/prisma/client';

export interface TenantPeople {
  /** Users that may create, place and fulfil orders (everyone but VIEWERs). */
  writers: string[];
}

function roleOf(index: number, count: number): WorkspaceRole {
  if (index === 0) return 'OWNER';
  if (index === 1) return 'ADMIN';
  return index === count - 1 && count > 2 ? 'VIEWER' : 'MEMBER';
}

function emailOf(tenant: TenantPlan, index: number): string {
  return index === 0
    ? `owner@${tenant.slug}.datagen.local`
    : `user-${String(index).padStart(2, '0')}@${tenant.slug}.datagen.local`;
}

export async function seedPeople(
  prisma: PrismaClient,
  tenants: readonly TenantPlan[],
  rng: Rng,
): Promise<Map<string, TenantPeople>> {
  // one hash for everyone: argon2 is deliberately slow, and every user shares the seed password
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const people = new Map<string, TenantPeople>();

  await prisma.workspace.createMany({
    data: tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      currency: t.currency,
      taxRateBps: t.taxRateBps,
      createdAt: new Date(t.startAt.getTime() - DAY),
    })),
  });

  const users: { id: string; email: string; passwordHash: string; createdAt: Date }[] = [];
  const memberships: {
    workspaceId: string;
    id: string;
    userId: string;
    role: WorkspaceRole;
    createdAt: Date;
  }[] = [];
  for (const tenant of tenants) {
    const writers: string[] = [];
    for (let i = 0; i < tenant.userCount; i++) {
      const joinedAt = new Date(tenant.startAt.getTime() - DAY + i * 1000);
      const userId = rng.uuidAt(joinedAt);
      const role = roleOf(i, tenant.userCount);
      users.push({ id: userId, email: emailOf(tenant, i), passwordHash, createdAt: joinedAt });
      memberships.push({
        workspaceId: tenant.id,
        id: rng.uuidAt(joinedAt),
        userId,
        role,
        createdAt: joinedAt,
      });
      if (role !== 'VIEWER') writers.push(userId);
    }
    people.set(tenant.id, { writers });
  }
  await prisma.user.createMany({ data: users });
  await prisma.membership.createMany({ data: memberships });
  return people;
}
