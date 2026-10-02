// The read replica (RPL-001…006; docs/adr/0009-read-replica-routing.md): the whole API with a
// real streaming standby behind the primary. Replication lag is made on demand by pausing WAL
// replay on the standby, so every case reads a replica that is provably in the past, with no
// sleep. Every test gets its own tenant; rows written through factories (the owner, past the
// API) leave no read-your-writes marker, which is how "someone else wrote" is staged.
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ReplicaPrismaService } from '@infra/database/replica-prisma.service';

import { membershipFactory, orderFactory, userFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { orderPath, ordersPath, V1 } from '../helpers/paths';
import { createTenant, type Tenant } from '../helpers/tenant';
import { appRoleUrl, databaseUrl } from '../setup/database-url';
import { testDb } from '../setup/db';
import { ReplicaControl } from '../setup/replica';

type Headers = Tenant['as'];

let api: ApiApp;
let replica: ReplicaControl;

beforeAll(async () => {
  // test/setup/db.ts pointed DATABASE_URL at this file's database on the primary: the replica
  // carries the same database under the same name
  const fileDb = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  const replicaServer = inject('pgReplicaUrl');
  process.env.DATABASE_REPLICA_URL = appRoleUrl(databaseUrl(replicaServer, fileDb));
  replica = await ReplicaControl.connect(replicaServer);
  api = await createApiApp();
});
afterAll(async () => {
  await api.close();
  await replica.close();
});

const primaryLsn = async (): Promise<string> => {
  const [row] = await testDb().$queryRaw<{ lsn: string }[]>`
    SELECT pg_current_wal_insert_lsn()::text AS lsn`;
  return row?.lsn ?? '';
};

/** The replica shows everything written so far, and then stops following the primary. */
const freezeReplica = async (): Promise<void> => {
  await replica.resumeAndCatchUp(await primaryLsn());
  await replica.pause();
};

const thawReplica = async (): Promise<void> => replica.resumeAndCatchUp(await primaryLsn());

/** A second MEMBER of the tenant's workspace. */
async function colleagueOf(t: Tenant): Promise<Headers> {
  const user = await userFactory.create();
  await membershipFactory.create({ workspaceId: t.workspaceId, userId: user.id, role: 'MEMBER' });
  return asUser(user.id);
}

const listedIds = async (t: Tenant, as: Headers): Promise<string[]> => {
  const { body } = await api.http().get(ordersPath(t.workspaceId)).set(as).expect(200);
  return (body as { items: { id: string }[] }).items.map((order) => order.id);
};

const createOrderViaApi = async (t: Tenant, as: Headers): Promise<string> => {
  const { body } = await api
    .http()
    .post(ordersPath(t.workspaceId))
    .set(as)
    .send({ items: [{ productId: t.productId, quantity: 1 }] })
    .expect(201);
  return (body as { id: string }).id;
};

// a test that failed while the replica was frozen must not freeze the next one
beforeEach(() => thawReplica());

describe('RPL-001 GET requests read the replica', () => {
  it('shows a list and an order as the replica has them, and the new rows once it caught up', async () => {
    const t = await createTenant();
    await freezeReplica();
    const order = await orderFactory.create(t.order);

    expect(await listedIds(t, t.as)).toEqual([]);
    await api.http().get(orderPath(t.workspaceId, order.id)).set(t.as).expect(404);

    await thawReplica();

    expect(await listedIds(t, t.as)).toEqual([order.id]);
    await api.http().get(orderPath(t.workspaceId, order.id)).set(t.as).expect(200);
  });
});

describe('RPL-002 a user reads their own writes', () => {
  it('serves the writer from the primary while the replica is behind, and nobody else', async () => {
    const t = await createTenant();
    const colleague = await colleagueOf(t);
    await freezeReplica();

    const id = await createOrderViaApi(t, t.as);

    expect(await listedIds(t, t.as)).toEqual([id]);
    await api.http().get(orderPath(t.workspaceId, id)).set(t.as).expect(200);
    expect(await listedIds(t, colleague)).toEqual([]);
  });

  it('returns the writer to the replica as soon as it has replayed their write', async () => {
    const t = await createTenant();
    const id = await createOrderViaApi(t, t.as);
    await freezeReplica(); // caught up with the write above, then frozen
    const later = await orderFactory.create(t.order);

    // the marker of the writer is still there; the replica already holds what it points at
    expect(await listedIds(t, t.as)).toEqual([id]);
    expect(await testDb().order.count({ where: { id: later.id } })).toBe(1);
  });

  it('covers a write that ended in an error: 409 on a stale version, then the fresh one', async () => {
    const t = await createTenant();
    const colleague = await colleagueOf(t);
    const order = await orderFactory.create(t.order);
    const path = orderPath(t.workspaceId, order.id);
    const edit = (version: number) => ({
      version,
      items: [{ productId: t.productId, quantity: 2 }],
      discount: { type: 'NONE' },
    });
    await freezeReplica();
    await api.http().patch(path).set(colleague).send(edit(0)).expect(204);

    // the replica still shows the version the colleague has replaced
    expect((await api.http().get(path).set(t.as).expect(200)).body).toMatchObject({ version: 0 });
    await api.http().patch(path).set(t.as).send(edit(0)).expect(409);

    expect((await api.http().get(path).set(t.as).expect(200)).body).toMatchObject({ version: 1 });
    await api.http().patch(path).set(t.as).send(edit(1)).expect(204);
  });
});

describe('RPL-003 a mutating request reads the primary', () => {
  it('snapshots the price the primary has, not the one the replica still shows', async () => {
    const t = await createTenant();
    await freezeReplica();
    await testDb().product.update({
      where: { workspaceId_id: { workspaceId: t.workspaceId, id: t.productId } },
      data: { priceMinor: 2500n },
    });

    const id = await createOrderViaApi(t, t.as);

    const [item] = await testDb().orderItem.findMany({ where: { orderId: id } });
    expect(item?.unitPriceMinor).toBe(2500n);
  });
});

describe('RPL-004 who am I, right after an anonymous write', () => {
  it('answers GET /me for a user the replica has not seen yet', async () => {
    await freezeReplica();
    const credentials = { email: 'fresh@example.test', password: 'long-enough-1' };
    await api.http().post(`${V1}/auth/register`).send(credentials).expect(201);
    const login = await api.http().post(`${V1}/auth/login`).send(credentials).expect(200);
    const { accessToken } = login.body as { accessToken: string };

    const me = await api
      .http()
      .get(`${V1}/me`)
      .set({ Authorization: `Bearer ${accessToken}` })
      .expect(200);

    expect(me.body).toMatchObject({ email: credentials.email });
  });
});

describe('RPL-005 the replica isolates tenants like the primary', () => {
  it('lists only the rows of the workspace, and none without a tenant', async () => {
    const [mine, theirs] = [await createTenant(), await createTenant()];
    const [own, foreign] = [
      await orderFactory.create(mine.order),
      await orderFactory.create(theirs.order),
    ];
    await thawReplica();

    expect(await listedIds(mine, mine.as)).toEqual([own.id]);
    await api.http().get(orderPath(mine.workspaceId, foreign.id)).set(mine.as).expect(404);

    const replicaClient = api.get(ReplicaPrismaService).client;
    const [visible] = await replicaClient.$queryRaw<{ rows: number }[]>`
      SELECT count(*)::int AS rows FROM orders`;
    expect(visible?.rows).toBe(0);
  });
});
