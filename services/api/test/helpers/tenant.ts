import type { WorkspaceRole } from '@infra/database/generated/prisma/client';

import { membershipFactory, productFactory, userFactory, workspaceFactory } from '../factories';

import { asUser } from './auth';

export interface Tenant {
  workspaceId: string;
  userId: string;
  productId: string;
  as: { Authorization: string };
  /** Arguments for orderFactory in this workspace (it has no seeded defaults). */
  order: {
    workspaceId: string;
    createdBy: string;
    lines: { productId: string; quantity: number }[];
  };
}

/**
 * A fresh workspace (EUR, tax 20 %) with one user of `role` and one ACTIVE product. For tests
 * that count rows — lists, pagination, query counts — so rows created by other tests of the
 * same file never leak in.
 */
export async function createTenant(role: WorkspaceRole = 'MEMBER'): Promise<Tenant> {
  const workspace = await workspaceFactory.create();
  const user = await userFactory.create();
  await membershipFactory.create({ workspaceId: workspace.id, userId: user.id, role });
  const product = await productFactory.create({ workspaceId: workspace.id, priceMinor: 1000n });
  return {
    workspaceId: workspace.id,
    userId: user.id,
    productId: product.id,
    as: asUser(user.id),
    order: {
      workspaceId: workspace.id,
      createdBy: user.id,
      lines: [{ productId: product.id, quantity: 1 }],
    },
  };
}
