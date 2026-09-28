// Fixed ids of the test seed (seed-test.ts). Tests reference these constants, never ids
// taken from a previous response. The identity world is the same as the dev seed
// (prisma/seed-data.ts, README → "Seeded data"); the catalog is test-only.
import { PASSWORD, seedId, USERS, WORKSPACES } from '../../prisma/seed-data';

export { PASSWORD };

export const WS_ACME = WORKSPACES.acme.id; // EUR, tax 20 %
export const WS_GLOBEX = WORKSPACES.globex.id; // USD, no tax

export const USER_ACME_OWNER = USERS.acmeOwner.id;
export const USER_ACME_ADMIN = USERS.acmeAdmin.id;
export const USER_ACME_MEMBER = USERS.acmeMember.id;
export const USER_ACME_VIEWER = USERS.acmeViewer.id;
export const USER_GLOBEX_OWNER = USERS.globexOwner.id;
export const USER_GLOBEX_ADMIN = USERS.globexAdmin.id;
export const USER_GLOBEX_MEMBER = USERS.globexMember.id;
export const USER_GLOBEX_VIEWER = USERS.globexViewer.id;
/** MEMBER in acme, VIEWER in globex. */
export const USER_BOTH = USERS.both.id;

// Test catalog: own id group `f1`, so a test id is never mistaken for a dev-seed product.
export const PRODUCT_ACME_ACTIVE = seedId('f1', 1);
export const PRODUCT_ACME_ARCHIVED = seedId('f1', 2);
export const PRODUCT_GLOBEX_ACTIVE = seedId('f1', 3);
