# Requirements (Step 0)

Numbered, testable requirements. Step 1 writes the tests **from this file**, not from the code.
Unless stated otherwise, routes are under `/v1`, workspace routes under
`/v1/workspaces/{workspaceId}`, and error bodies have the shape
`{ code, message, details? }` (`ErrorResponseDto`).

Status codes used by the API: `400` malformed or invalid input (`VALIDATION_FAILED` or a
domain `DomainError`), `401` no or invalid token, `403` member without permission, `404` not
found or not visible, `409` stale `version` or duplicate, `422` action not possible in the
current state.

## Test levels

The `Level` column says where a requirement is tested (Step 1).

| Level     | What runs                                                          | Vitest project | Files                             |
| --------- | ------------------------------------------------------------------ | -------------- | --------------------------------- |
| `unit`    | domain, value objects, policies; no Nest, no infrastructure        | `unit`         | `src/**/*.spec.ts`                |
| `adapter` | an outbound adapter: HTTP against MSW handlers (1.10), a publisher | `unit`         | `src/**/infrastructure/*.spec.ts` |
| `int`     | a repository or a DB constraint against a real Postgres (1.6)      | `e2e`          | `test/**/*.int-spec.ts`           |
| `api`     | the whole app through Supertest, with the worker and the broker    | `e2e`          | `test/**/*.e2e-spec.ts`           |

A rule is tested in full at the **lowest** level where it lives. A higher level adds only
what the lower one cannot see (HTTP mapping, guards, transactions, "nothing was written"),
with one or two representative cases, not the whole matrix again.

Since 3.2 a level prefixed with `payments` is a test of `services/payments` (the same two
Vitest projects there); every other level is a test of `services/api`. Each service is tested
to its boundary: the test is the other side of the broker. The path through both is roadmap
3.13.

Distribution as counted in Step 1, before the PAY rows were split between the two services
(106 requirements; one with two levels counts in both):

| Level     | Requirements | Only this level |
| --------- | -----------: | --------------: |
| `unit`    |           39 |              14 |
| `adapter` |            4 |               1 |
| `int`     |           14 |               9 |
| `api`     |           81 |              50 |

Most requirements need the running API: the "testing trophy", not the pyramid.

---

## CALC: order calculations

All amounts are integers in minor units (BigInt in code). `roundHalfUp(x / d)` rounds half
away from zero, and all values here are non-negative.

| Id       | Requirement                                                                                                                                                                                                 | Level        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| CALC-001 | `lineTotal = unitPrice × quantity` for every item.                                                                                                                                                          | `unit`       |
| CALC-002 | `subtotal = Σ lineTotal`; an order with no items has `subtotal = 0`.                                                                                                                                        | `unit`       |
| CALC-003 | Discount `NONE` → `discount = 0`.                                                                                                                                                                           | `unit`       |
| CALC-004 | Discount `PERCENT(valueBps)` → `discount = roundHalfUp(subtotal × valueBps / 10000)`.                                                                                                                       | `unit`       |
| CALC-005 | Discount `FIXED(valueMinor)` → `discount = min(valueMinor, subtotal)`.                                                                                                                                      | `unit`       |
| CALC-006 | `taxable = subtotal − discount`; `tax = roundHalfUp(taxable × taxRateBps / 10000)`.                                                                                                                         | `unit`       |
| CALC-007 | `total = taxable + tax`.                                                                                                                                                                                    | `unit`       |
| CALC-008 | Invariant: `0 ≤ discount ≤ subtotal` for every valid discount and item set.                                                                                                                                 | `unit`       |
| CALC-009 | Invariant: `total ≥ 0`.                                                                                                                                                                                     | `unit`       |
| CALC-010 | Invariant: `subtotal = Σ lineTotal` of the stored items; stored `lineTotalMinor = unitPriceMinor × quantity`.                                                                                               | `unit + int` |
| CALC-011 | Invariant: stored `totalMinor = subtotalMinor − discountMinor + taxMinor` (also a DB CHECK).                                                                                                                | `int`        |
| CALC-012 | `currency` of an order is copied from its workspace at creation and never changes.                                                                                                                          | `api`        |
| CALC-013 | `taxRateBps` of an order is a snapshot of the workspace rate at creation.                                                                                                                                   | `api`        |
| CALC-014 | Item `sku`, `name`, `unitPrice` are snapshots taken when the items are set (create / PATCH); later product edits do not change the order.                                                                   | `api`        |
| CALC-015 | Examples: 3 × 1250 EUR, PERCENT 1000, tax 2000 → subtotal 3750, discount 375, tax 675, total 4050. 2 × 299 EUR, no discount, tax 2000 → total 718. PERCENT 5000 of subtotal 3 → discount 2 (1.5 rounds up). | `unit + api` |
| CALC-016 | Money in JSON is `{ amountMinor: integer, currency: "XXX" }`.                                                                                                                                               | `api`        |

Property tests (Step 1) for CALC-008…011 over random items (0…50, quantity 1…1000, price
1…100 000 000), random discounts and tax 0…5000: `orders/domain/order-totals.prop.spec.ts`
(plus an independent oracle, rounding bounds, monotonicity, line order), with generators in
`orders/domain/__test__/arbitraries.ts`. `Money` and `discountOf` (ORD-007) have their own
`*.prop.spec.ts` next to them.

## ORD: order lifecycle and state machine

Allowed transitions (anything else is `422 ORDER_INVALID_TRANSITION`):

| From            | Action                                | To              |
| --------------- | ------------------------------------- | --------------- |
| DRAFT           | place                                 | PENDING_PAYMENT |
| DRAFT           | cancel                                | CANCELLED       |
| PENDING_PAYMENT | payment succeeded (worker)            | PAID            |
| PENDING_PAYMENT | declined / retries exhausted (worker) | PAYMENT_FAILED  |
| PAYMENT_FAILED  | place (retry)                         | PENDING_PAYMENT |
| PAYMENT_FAILED  | cancel                                | CANCELLED       |
| PAID            | fulfill                               | FULFILLED       |

| Id      | Requirement                                                                                                                                                                                                         | Level        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| ORD-001 | `POST /orders` creates an order in `DRAFT` with `paymentAttempt = 0`, `version = 0` → `201 { id }` + `Location`.                                                                                                    | `api`        |
| ORD-002 | Create/PATCH accept 0…50 items; a DRAFT may be empty. 51 items → 400.                                                                                                                                               | `unit + api` |
| ORD-003 | Item `quantity` must be an integer 1…1000, else 400.                                                                                                                                                                | `unit + api` |
| ORD-004 | The same `productId` twice in one order → `400 INVALID_ORDER`.                                                                                                                                                      | `unit + api` |
| ORD-005 | An unknown product id (or a product of another workspace) → `404 PRODUCT_NOT_FOUND`.                                                                                                                                | `api`        |
| ORD-006 | An `ARCHIVED` product → `422 PRODUCT_NOT_ACTIVE`.                                                                                                                                                                   | `unit + api` |
| ORD-007 | Discount shape: `NONE` takes no value; `PERCENT` needs `valueBps` 0…10000 and no `valueMinor`; `FIXED` needs `valueMinor` ≥ 0 (≤ 2^53−1) and no `valueBps`. Otherwise 400.                                          | `unit + api` |
| ORD-008 | `PATCH /orders/{id}` replaces items and discount (both required) only in DRAFT → 204; in any other status → `422 ORDER_NOT_EDITABLE`.                                                                               | `unit + api` |
| ORD-009 | `PATCH`, `place`, `cancel`, `fulfill` require `{ version }` equal to the current order version, else `409 STALE_VERSION`. Missing `version` → 400.                                                                  | `unit + api` |
| ORD-010 | Every successful write increments `version` by exactly 1.                                                                                                                                                           | `int + api`  |
| ORD-011 | `place` from DRAFT or PAYMENT_FAILED → `202 { id, status: "PENDING_PAYMENT" }` + `Location` of the order; `paymentAttempt` increases by 1; `failureReason` is cleared; `placedAt` is set.                           | `unit + api` |
| ORD-012 | `place` of an order with 0 items → `422 ORDER_HAS_NO_ITEMS`.                                                                                                                                                        | `unit + api` |
| ORD-013 | `place` from PENDING_PAYMENT, PAID, FULFILLED or CANCELLED → 422.                                                                                                                                                   | `unit + api` |
| ORD-014 | `cancel` from DRAFT or PAYMENT_FAILED → 204, status CANCELLED, `cancelledAt` set.                                                                                                                                   | `unit + api` |
| ORD-015 | `cancel` from PENDING_PAYMENT → `422 ORDER_INVALID_TRANSITION` (Step 0; the saga solves it in Step 3).                                                                                                              | `unit + api` |
| ORD-016 | `cancel` from PAID, FULFILLED, CANCELLED → 422.                                                                                                                                                                     | `unit + api` |
| ORD-017 | `fulfill` from PAID → 204, status FULFILLED, `fulfilledAt` set; from any other status → 422.                                                                                                                        | `unit + api` |
| ORD-018 | Every status change appends exactly one row to the order history in the same transaction; `GET /orders/{id}/events` returns them oldest first: `type`, `fromStatus`, `toStatus`, `actor`, `payload`, `createdAt`.   | `int + api`  |
| ORD-019 | Creation appends `ORDER_CREATED` (null → DRAFT). PATCH appends nothing (not a status change).                                                                                                                       | `unit + api` |
| ORD-020 | `actor` is the user id for user actions and `system:consumer:orders` for payment outcomes.                                                                                                                          | `api`        |
| ORD-021 | `ORDER_PLACED.payload = { paymentAttempt }`; `PAYMENT_SUCCEEDED.payload = { paymentAttempt, pspChargeId }`; `PAYMENT_FAILED.payload = { paymentAttempt, reason }`.                                                  | `unit + api` |
| ORD-022 | A rejected transition writes nothing: no status change, no history row, no version change.                                                                                                                          | `unit + api` |
| ORD-023 | `GET /orders` lists newest first with `{ items, nextCursor }`; `?status=` filters; `limit` 1…100 (default 20); a malformed `cursor` → `400 INVALID_CURSOR`; following `nextCursor` never repeats or skips an order. | `api`        |
| ORD-024 | `GET /orders/{id}` returns items (in the order given), discount, totals, status and all timestamps; absent values are `null`, never missing.                                                                        | `api`        |
| ORD-025 | Non-UUID `orderId` → 400.                                                                                                                                                                                           | `api`        |

## PAY: asynchronous payment (api → RabbitMQ → payments-service → api)

The api asks with the command `payments.charge-payment` and is answered with the event
`payments.payment-succeeded` or `payments.payment-failed` (`packages/contracts`, ADR 0011,
ADR 0012).

| Id      | Requirement                                                                                                                                                                                                                                       | Level                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| PAY-001 | After `place` commits, the api publishes `payments.charge-payment` v1 to the exchange `commands`, routed by its name, with the order's workspace in the envelope and `{ orderId, paymentAttempt }`.                                               | `unit + adapter + api`             |
| PAY-002 | One `place` sends one command.                                                                                                                                                                                                                    | `api`                              |
| PAY-003 | The command carries `total` in the order currency and the idempotency key `<orderId>:<attempt>`; payments charges exactly that, with reference `<orderId>`.                                                                                       | `adapter + api`, `payments e2e`    |
| PAY-004 | PSP `succeeded` → `payments.payment-succeeded` with the charge id → PAID, `pspChargeId` set, `paidAt` set, history `PAYMENT_SUCCEEDED`.                                                                                                           | `unit + api`, `payments e2e`       |
| PAY-005 | PSP `declined` → `payments.payment-failed` with the decline code → PAYMENT_FAILED, `failureReason = declineCode`, history `PAYMENT_FAILED`; **no retry**.                                                                                         | `unit + api`, `payments e2e`       |
| PAY-006 | Transient failure (HTTP 5xx or 429, network error, timeout > 3 s) is retried before the attempt is given up. **Not implemented since 3.2** (BullMQ did it): roadmap 3.3 and 3.11. The adapter still tells transient from final.                   | `payments adapter`; e2e: `it.todo` |
| PAY-007 | A transient failure that is not retried any more → `payments.payment-failed` with `declineCode = "psp_unavailable"`, no charge id → PAYMENT_FAILED with that reason. Since 3.2: after the first call.                                             | `api`, `payments e2e`              |
| PAY-008 | A non-transient PSP failure (other 4xx, malformed body) → `declineCode = "psp_rejected"` → PAYMENT_FAILED with that reason, no retry.                                                                                                             | `api`, `payments adapter + e2e`    |
| PAY-009 | Idempotent consumers. api: an event for an order that is not PENDING_PAYMENT, or for another `paymentAttempt`, is acknowledged and writes nothing. payments: a command for a settled attempt calls no PSP and publishes the stored outcome again. | `unit + api`, `payments e2e`       |
| PAY-010 | The same message handled twice, also by two processes at once, creates one charge at the PSP, one row in `payments`, one PAID and one history entry.                                                                                              | `api`, `payments e2e`              |
| PAY-011 | Placing again after PAYMENT_FAILED uses a new attempt and therefore a new idempotency key (`<orderId>:2`, …) and a new row in `payments`; a late answer for the old attempt changes nothing.                                                      | `unit + api`, `payments e2e`       |
| PAY-012 | The worker binds the tenant from the envelope's `workspaceId`; it can only read and write that workspace. payments stores the workspace and returns it in the answer.                                                                             | `unit + api`, `payments e2e`       |
| PAY-013 | Only the actor `system:consumer:orders` may record a payment outcome in the api; only `system:consumer:payments` may charge in payments (policies).                                                                                               | `unit`, `payments unit`            |
| PAY-014 | With `PAYMENT_GATEWAY=fake` (payments) no network is used; amounts whose minor units end in `13` are declined (`card_declined`), everything else succeeds.                                                                                        | `payments adapter`                 |
| PAY-015 | A message that is not a known contract (not JSON, no name, an unknown version, a broken payload, a message of another queue) is rejected without requeue, and the consumer serves the next one.                                                   | `unit + api`, `payments e2e`       |

## AUTH: authentication

| Id       | Requirement                                                                                                                                      | Level |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| AUTH-001 | `POST /auth/register { email, password }` → `201 { id }`; email is stored lower-cased.                                                           | `api` |
| AUTH-002 | Registering an email that exists in any letter case → `409 EMAIL_ALREADY_REGISTERED`.                                                            | `api` |
| AUTH-003 | Password 8…128 chars; email valid and ≤ 254 chars; else 400. Unknown body fields → 400.                                                          | `api` |
| AUTH-004 | `POST /auth/login` with valid credentials → `200 { accessToken, expiresIn }` (HS256 JWT, claims `sub`, `iat`, `exp`, `jti`; no email, no roles). | `api` |
| AUTH-005 | Wrong password or unknown email → `401 INVALID_CREDENTIALS`, same body for both.                                                                 | `api` |
| AUTH-006 | Every non-public route without a token, with a malformed, wrongly signed or expired token → `401 UNAUTHORIZED`.                                  | `api` |
| AUTH-007 | `GET /me` → the user (`id`, `email`, `createdAt`) and all memberships (`workspaceId`, `workspaceName`, `workspaceSlug`, `role`).                 | `api` |

## TEN: tenancy and isolation

| Id      | Requirement                                                                                                                                                                                                                    | Level       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| TEN-001 | A caller who is not a member of `{workspaceId}` gets `404 WORKSPACE_NOT_FOUND` on every workspace route, for existing and non-existing workspaces alike.                                                                       | `api`       |
| TEN-002 | A non-UUID `{workspaceId}` → 404 (never 500).                                                                                                                                                                                  | `api`       |
| TEN-003 | A member of workspace A requesting a product/order id that belongs to workspace B under A's path → 404 (`PRODUCT_NOT_FOUND` / `ORDER_NOT_FOUND`).                                                                              | `api`       |
| TEN-004 | Lists (`products`, `orders`, `members`, `events`) never contain rows of another workspace.                                                                                                                                     | `api`       |
| TEN-005 | An order cannot reference a product of another workspace (TEN-003 + DB composite FK).                                                                                                                                          | `int + api` |
| TEN-006 | Any query on a tenant table without a tenant in context fails (500), never returns data.                                                                                                                                       | `int`       |
| TEN-007 | The user who belongs to both seeded workspaces sees each with its own role.                                                                                                                                                    | `api`       |
| TEN-008 | `GET /workspaces` lists only the caller's workspaces, with `myRole`.                                                                                                                                                           | `api`       |
| TEN-009 | As the application's database role, without a tenant in the transaction, a tenant table returns no row and refuses every write; the tenant ends with the transaction.                                                          | `int`       |
| TEN-010 | With a tenant in the transaction the database returns, updates, deletes and accepts only that tenant's rows, with no filter in the query.                                                                                      | `int`       |
| TEN-011 | With a user in the transaction the database returns that user's memberships in every workspace and nobody else's; it accepts no membership write.                                                                              | `int`       |
| TEN-012 | The application role is no superuser, cannot bypass row security and owns no table; every table with `workspace_id` has a policy; partitions and the migration history carry no grant.                                         | `int`       |
| TEN-013 | Through PgBouncer in transaction mode every tenant still gets only its rows and a transaction keeps one server connection; a transaction-local setting ends with the transaction, a session-level one reaches the next client. | `int`       |

## PERM: permissions (member of the workspace)

| Action                                                 | VIEWER | MEMBER | ADMIN | OWNER |
| ------------------------------------------------------ | ------ | ------ | ----- | ----- |
| Read catalog, orders, order events, members, workspace | 200    | 200    | 200   | 200   |
| Create / edit draft order, place, cancel               | 403    | ✓      | ✓     | ✓     |
| Create / edit / archive products                       | 403    | 403    | ✓     | ✓     |
| Fulfill order                                          | 403    | 403    | ✓     | ✓     |
| Add member with role MEMBER or VIEWER                  | 403    | 403    | ✓     | ✓     |
| Add member with role ADMIN or OWNER                    | 403    | 403    | 403   | ✓     |

| Id       | Requirement                                                                                                        | Level        |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ------------ |
| PERM-001 | Every cell of the table above holds; `403` has body `{ code: "FORBIDDEN", message: "Forbidden" }` without details. | `unit + api` |
| PERM-002 | The permission check happens before the state check: a VIEWER cancelling a PAID order gets 403, not 422.           | `api`        |
| PERM-003 | A 403 changes nothing (no write, no history, no version bump).                                                     | `api`        |

## WS: workspaces and members

| Id     | Requirement                                                                                                                             | Level |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| WS-001 | `POST /workspaces { name 1…100, slug 3…50 [a-z0-9-], currency ISO 4217, taxRateBps 0…5000 }` → 201; the creator becomes OWNER.          | `api` |
| WS-002 | A taken slug → `409 WORKSPACE_SLUG_TAKEN`.                                                                                              | `api` |
| WS-003 | `POST /members { email, role }`: unknown email → `404 USER_NOT_FOUND`; already a member → `409 ALREADY_MEMBER`; success → `201 { id }`. | `api` |
| WS-004 | `GET /members` lists members with `userId`, `email`, `role`, cursor-paginated.                                                          | `api` |

## CAT: catalog

| Id      | Requirement                                                                                                                      | Level       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| CAT-001 | `POST /products { sku, name, description?, priceMinor }` → 201; product is ACTIVE.                                               | `api`       |
| CAT-002 | `sku` 1…64 chars `[A-Za-z0-9._-]`, unique per workspace (`409 PRODUCT_SKU_TAKEN`); the same sku in another workspace is allowed. | `int + api` |
| CAT-003 | `priceMinor` integer 1…100 000 000; `name` 1…200; `description` ≤ 2000 or null.                                                  | `api`       |
| CAT-004 | `PATCH /products/{id}` updates `name`, `description` (null clears), `priceMinor` → 204; `sku` is immutable (sending it → 400).   | `api`       |
| CAT-005 | `POST /products/{id}/archive` → 204, status ARCHIVED; archiving again is a no-op 204. Products are never deleted.                | `api`       |
| CAT-006 | `GET /products` newest first, `?status=ACTIVE\|ARCHIVED`, cursor pagination as ORD-023.                                          | `api`       |
| CAT-007 | Product `price` is returned as money in the workspace currency.                                                                  | `api`       |

## VAL: validation and API contract

| Id      | Requirement                                                                                                                                                              | Level |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| VAL-001 | Unknown fields in any body or query → `400 VALIDATION_FAILED` with `details.fields[] = { path, code, message }` (dot paths with array indices, e.g. `items.0.quantity`). | `api` |
| VAL-002 | Malformed JSON → 400; body > 10 kB → 413.                                                                                                                                | `api` |
| VAL-003 | Every documented status code in `/docs-json` is the only set of codes an operation returns (Schemathesis).                                                               | `api` |
| VAL-004 | Responses match their documented schema: all declared fields present, `null` where absent; dates ISO-8601 UTC.                                                           | `api` |
| VAL-005 | `Location` header on every 201 (new resource) and 202 (the order).                                                                                                       | `api` |

## OPS: order history partitions (Step 2.3)

`order_events` is partitioned by month on `created_at` (UTC). The worker job
`maintain-order-event-partitions` keeps it writable and, when a retention is set, bounded.

| Id      | Requirement                                                                                                                                                                             | Level        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| OPS-001 | After a maintenance run the current month and `ORDER_EVENTS_PARTITIONS_AHEAD` months after it have a partition; existing ones are left alone. A worker runs it at boot and daily.       | `unit + api` |
| OPS-002 | With `ORDER_EVENTS_RETENTION_MONTHS = N > 0`, partitions older than N full months are dropped, after the coming months exist; `0` keeps everything; the current month is never dropped. | `unit`       |
| OPS-003 | Only `system:job:maintain-order-event-partitions` may run the maintenance.                                                                                                              | `unit`       |
| OPS-004 | A run fails (and is retried, then alerted as a dead job) when a required month still has no partition.                                                                                  | `unit`       |
| OPS-005 | An event is stored in the partition of its UTC month; a month without a partition rejects the write (there is no DEFAULT partition).                                                    | `int`        |
| OPS-006 | Dropping a partition removes the events of that month and nothing else; a repeated drop is a no-op. The application role does it through a function and cannot run the DDL itself.      | `int`        |

## RPL: read replica and read-your-writes (Step 2.8)

With `DATABASE_REPLICA_URL` set, reads are routed between the primary and an asynchronous
streaming replica (`docs/adr/0009-read-replica-routing.md`). "Behind" below means the replica
has not replayed a commit of the primary yet.

| Id      | Requirement                                                                                                                                                                                                                                           | Level        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RPL-001 | A `GET` of a user who has written nothing lately is served by the replica: it shows what the replica has replayed, and the newer rows once it caught up.                                                                                              | `api`        |
| RPL-002 | After a mutating request, successful or failed, the caller's `GET`s are served by the primary while the replica is behind that request, and by the replica again once it has replayed it. Other users are not affected.                               | `unit + api` |
| RPL-003 | A mutating request reads the primary: an order snapshots the price the primary has, whatever the replica still shows.                                                                                                                                 | `api`        |
| RPL-004 | `GET /me` answers for a user who registered and logged in while the replica was behind.                                                                                                                                                               | `api`        |
| RPL-005 | Through the replica a tenant still gets only its rows, and the application role sees no tenant row without a tenant.                                                                                                                                  | `api`        |
| RPL-006 | The position of the primary unreadable → the writer reads the primary until the marker expires. Redis not answering → the read goes to the replica; the replica not answering the position check → to the primary; a write never fails on its marker. | `unit`       |

## CCH: catalog cache (Step 2.9)

`GET /products` and `GET /products/{id}` are served from Redis when they can be
(`docs/adr/0010-catalog-cache.md`). A cached answer is the same body the database would give.

| Id      | Requirement                                                                                                                                                                                    | Level        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| CCH-001 | A repeated read of a product or of a list page (same status, limit, cursor) is answered from the cache, without the catalog queries. A missing product is not cached.                          | `unit + api` |
| CCH-002 | After `POST /products`, `PATCH /products/{id}` or `POST /products/{id}/archive` the next read of that product and of every list of the workspace shows the change.                             | `unit + api` |
| CCH-003 | The cache keeps tenants apart: a workspace gets its own lists, never a cached product of another, and a change in one workspace leaves the cache of another warm. A non-member still gets 404. | `api`        |
| CCH-004 | Callers that miss the same key together cause one database read, across processes too; a lock is released by its holder only, and a lock nobody releases delays a read and never blocks it.    | `unit + int` |
| CCH-005 | Redis not answering: the read is served from the database and a write succeeds; nothing fails on the cache.                                                                                    | `unit`       |
| CCH-006 | The cache is filled from the primary: after a change, a user whose other reads still come from a replica that is behind gets the new product, and keeps getting it.                            | `unit + api` |
