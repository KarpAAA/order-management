// CAT-002: SKU is unique per workspace. The rule lives in two places — the unique index
// (workspace_id, sku) and CatalogService, which turns Prisma's P2002 into SkuTakenError —
// so the test goes through the real service, as an ADMIN of the workspace.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { userActor } from '@shared/auth/actor';
import { WorkspaceRole } from '@shared/auth/workspace-role';

import { CatalogPolicy } from '@modules/catalog/catalog.policy';
import { CatalogService } from '@modules/catalog/catalog.service';
import { SkuTakenError } from '@modules/catalog/errors';

import { createIntModule, type IntModule } from '../helpers/int-module';
import { USER_ACME_ADMIN, USER_GLOBEX_ADMIN, WS_ACME, WS_GLOBEX } from '../seed/ids';
import { testDb } from '../setup/db';

let app: IntModule;
let catalog: CatalogService;

beforeAll(async () => {
  app = await createIntModule({ providers: [CatalogService, CatalogPolicy] });
  catalog = app.get(CatalogService);
});
afterAll(() => app.close());

const createAs = (workspaceId: string, userId: string, sku: string) =>
  app.asMember({ workspaceId, userId, role: WorkspaceRole.Admin }, () =>
    catalog.create(
      { workspaceId, sku, name: `Product ${sku}`, description: null, priceMinor: 500n },
      userActor(userId),
    ),
  );

describe('CatalogService.create — SKU uniqueness (CAT-002)', () => {
  it('rejects a SKU already used in the same workspace', async () => {
    await createAs(WS_ACME, USER_ACME_ADMIN, 'DUP-SKU');

    await expect(createAs(WS_ACME, USER_ACME_ADMIN, 'DUP-SKU')).rejects.toBeInstanceOf(
      SkuTakenError,
    );
    expect(await testDb().product.count({ where: { sku: 'DUP-SKU' } })).toBe(1);
  });

  it('allows the same SKU in another workspace', async () => {
    await createAs(WS_ACME, USER_ACME_ADMIN, 'SHARED-SKU');
    await createAs(WS_GLOBEX, USER_GLOBEX_ADMIN, 'SHARED-SKU');

    const rows = await testDb().product.findMany({ where: { sku: 'SHARED-SKU' } });
    expect(rows.map((r) => r.workspaceId).sort()).toEqual([WS_ACME, WS_GLOBEX].sort());
  });
});
