# Requirements (Step 0)

Numbered, testable requirements. Step 1 writes the tests **from this file**, not from the code.
Unless stated otherwise, routes are under `/v1`, workspace routes under
`/v1/workspaces/{workspaceId}`, and error bodies have the shape
`{ code, message, details? }` (`ErrorResponseDto`).

Status codes used by the API: `400` malformed or invalid input (`VALIDATION_FAILED` or a
domain `DomainError`), `401` no or invalid token, `403` member without permission, `404` not
found or not visible, `409` stale `version` or duplicate, `422` action not possible in the
current state.

---

## CALC: order calculations

All amounts are integers in minor units (BigInt in code). `roundHalfUp(x / d)` rounds half
away from zero, and all values here are non-negative.

| Id       | Requirement                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CALC-001 | `lineTotal = unitPrice × quantity` for every item.                                                                                                                                                          |
| CALC-002 | `subtotal = Σ lineTotal`; an order with no items has `subtotal = 0`.                                                                                                                                        |
| CALC-003 | Discount `NONE` → `discount = 0`.                                                                                                                                                                           |
| CALC-004 | Discount `PERCENT(valueBps)` → `discount = roundHalfUp(subtotal × valueBps / 10000)`.                                                                                                                       |
| CALC-005 | Discount `FIXED(valueMinor)` → `discount = min(valueMinor, subtotal)`.                                                                                                                                      |
| CALC-006 | `taxable = subtotal − discount`; `tax = roundHalfUp(taxable × taxRateBps / 10000)`.                                                                                                                         |
| CALC-007 | `total = taxable + tax`.                                                                                                                                                                                    |
| CALC-008 | Invariant: `0 ≤ discount ≤ subtotal` for every valid discount and item set.                                                                                                                                 |
| CALC-009 | Invariant: `total ≥ 0`.                                                                                                                                                                                     |
| CALC-010 | Invariant: `subtotal = Σ lineTotal` of the stored items; stored `lineTotalMinor = unitPriceMinor × quantity`.                                                                                               |
| CALC-011 | Invariant: stored `totalMinor = subtotalMinor − discountMinor + taxMinor` (also a DB CHECK).                                                                                                                |
| CALC-012 | `currency` of an order is copied from its workspace at creation and never changes.                                                                                                                          |
| CALC-013 | `taxRateBps` of an order is a snapshot of the workspace rate at creation.                                                                                                                                   |
| CALC-014 | Item `sku`, `name`, `unitPrice` are snapshots taken when the items are set (create / PATCH); later product edits do not change the order.                                                                   |
| CALC-015 | Examples: 3 × 1250 EUR, PERCENT 1000, tax 2000 → subtotal 3750, discount 375, tax 675, total 4050. 2 × 299 EUR, no discount, tax 2000 → total 718. PERCENT 5000 of subtotal 3 → discount 2 (1.5 rounds up). |
| CALC-016 | Money in JSON is `{ amountMinor: integer, currency: "XXX" }`.                                                                                                                                               |

Property tests (Step 1) for CALC-008…011 over random items (1…50, quantity 1…1000, price
1…100 000 000), random discounts and tax 0…5000.

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

| Id      | Requirement                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORD-001 | `POST /orders` creates an order in `DRAFT` with `paymentAttempt = 0`, `version = 0` → `201 { id }` + `Location`.                                                                                                    |
| ORD-002 | Create/PATCH accept 0…50 items; a DRAFT may be empty. 51 items → 400.                                                                                                                                               |
| ORD-003 | Item `quantity` must be an integer 1…1000, else 400.                                                                                                                                                                |
| ORD-004 | The same `productId` twice in one order → `400 INVALID_ORDER`.                                                                                                                                                      |
| ORD-005 | An unknown product id (or a product of another workspace) → `404 PRODUCT_NOT_FOUND`.                                                                                                                                |
| ORD-006 | An `ARCHIVED` product → `422 PRODUCT_NOT_ACTIVE`.                                                                                                                                                                   |
| ORD-007 | Discount shape: `NONE` takes no value; `PERCENT` needs `valueBps` 0…10000 and no `valueMinor`; `FIXED` needs `valueMinor` ≥ 0 (≤ 2^53−1) and no `valueBps`. Otherwise 400.                                          |
| ORD-008 | `PATCH /orders/{id}` replaces items and discount (both required) only in DRAFT → 204; in any other status → `422 ORDER_NOT_EDITABLE`.                                                                               |
| ORD-009 | `PATCH`, `place`, `cancel`, `fulfill` require `{ version }` equal to the current order version, else `409 STALE_VERSION`. Missing `version` → 400.                                                                  |
| ORD-010 | Every successful write increments `version` by exactly 1.                                                                                                                                                           |
| ORD-011 | `place` from DRAFT or PAYMENT_FAILED → `202 { id, status: "PENDING_PAYMENT" }` + `Location` of the order; `paymentAttempt` increases by 1; `failureReason` is cleared; `placedAt` is set.                           |
| ORD-012 | `place` of an order with 0 items → `422 ORDER_HAS_NO_ITEMS`.                                                                                                                                                        |
| ORD-013 | `place` from PENDING_PAYMENT, PAID, FULFILLED or CANCELLED → 422.                                                                                                                                                   |
| ORD-014 | `cancel` from DRAFT or PAYMENT_FAILED → 204, status CANCELLED, `cancelledAt` set.                                                                                                                                   |
| ORD-015 | `cancel` from PENDING_PAYMENT → `422 ORDER_INVALID_TRANSITION` (Step 0; the saga solves it in Step 3).                                                                                                              |
| ORD-016 | `cancel` from PAID, FULFILLED, CANCELLED → 422.                                                                                                                                                                     |
| ORD-017 | `fulfill` from PAID → 204, status FULFILLED, `fulfilledAt` set; from any other status → 422.                                                                                                                        |
| ORD-018 | Every status change appends exactly one row to the order history in the same transaction; `GET /orders/{id}/events` returns them oldest first: `type`, `fromStatus`, `toStatus`, `actor`, `payload`, `createdAt`.   |
| ORD-019 | Creation appends `ORDER_CREATED` (null → DRAFT). PATCH appends nothing (not a status change).                                                                                                                       |
| ORD-020 | `actor` is the user id for user actions and `system:consumer:orders` for payment outcomes.                                                                                                                          |
| ORD-021 | `ORDER_PLACED.payload = { paymentAttempt }`; `PAYMENT_SUCCEEDED.payload = { paymentAttempt, pspChargeId }`; `PAYMENT_FAILED.payload = { paymentAttempt, reason }`.                                                  |
| ORD-022 | A rejected transition writes nothing: no status change, no history row, no version change.                                                                                                                          |
| ORD-023 | `GET /orders` lists newest first with `{ items, nextCursor }`; `?status=` filters; `limit` 1…100 (default 20); a malformed `cursor` → `400 INVALID_CURSOR`; following `nextCursor` never repeats or skips an order. |
| ORD-024 | `GET /orders/{id}` returns items (in the order given), discount, totals, status and all timestamps; absent values are `null`, never missing.                                                                        |
| ORD-025 | Non-UUID `orderId` → 400.                                                                                                                                                                                           |

## PAY: asynchronous payment (worker)

| Id      | Requirement                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PAY-001 | After `place` commits, a job `charge-order` with `{ workspaceId, orderId, paymentAttempt }` and job id `charge-<orderId>-<attempt>` is enqueued on queue `orders`.     |
| PAY-002 | The same attempt is never enqueued twice while the first job exists (deterministic job id).                                                                            |
| PAY-003 | The worker charges `total` in the order currency with PSP idempotency key `<orderId>:<attempt>` and reference `<orderId>`.                                             |
| PAY-004 | PSP `succeeded` → PAID, `pspChargeId` set, `paidAt` set, history `PAYMENT_SUCCEEDED`.                                                                                  |
| PAY-005 | PSP `declined` → PAYMENT_FAILED, `failureReason = declineCode`, history `PAYMENT_FAILED`; **no retry** of the job.                                                     |
| PAY-006 | Transient failure (HTTP 5xx or 429, network error, timeout > 3 s) → the job throws and BullMQ retries: 5 attempts in total, exponential backoff (base 1 s by default). |
| PAY-007 | A transient failure on the last attempt → PAYMENT_FAILED with `failureReason = "psp_unavailable"`; the job completes (not dead).                                       |
| PAY-008 | A non-transient PSP failure (other 4xx, malformed body) → PAYMENT_FAILED with `failureReason = "psp_rejected"`, no retry.                                              |
| PAY-009 | Idempotent handler: if the order is not PENDING_PAYMENT, or its `paymentAttempt` differs from the job's, the job does nothing and completes (no PSP call, no write).   |
| PAY-010 | Re-running a job for an already settled attempt creates no second charge at the PSP (`GET /charges` on fake-psp unchanged).                                            |
| PAY-011 | Placing again after PAYMENT_FAILED uses a new attempt and therefore a new idempotency key (`<orderId>:2`, …).                                                          |
| PAY-012 | The worker binds the tenant from the job's `workspaceId`; it can only read and write that workspace.                                                                   |
| PAY-013 | Only the actor `system:consumer:orders` may record a payment outcome (policy).                                                                                         |
| PAY-014 | With `PAYMENT_GATEWAY=fake` no network is used; amounts whose minor units end in `13` are declined (`card_declined`), everything else succeeds.                        |

## AUTH: authentication

| Id       | Requirement                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| AUTH-001 | `POST /auth/register { email, password }` → `201 { id }`; email is stored lower-cased.                                                           |
| AUTH-002 | Registering an email that exists in any letter case → `409 EMAIL_ALREADY_REGISTERED`.                                                            |
| AUTH-003 | Password 8…128 chars; email valid and ≤ 254 chars; else 400. Unknown body fields → 400.                                                          |
| AUTH-004 | `POST /auth/login` with valid credentials → `200 { accessToken, expiresIn }` (HS256 JWT, claims `sub`, `iat`, `exp`, `jti`; no email, no roles). |
| AUTH-005 | Wrong password or unknown email → `401 INVALID_CREDENTIALS`, same body for both.                                                                 |
| AUTH-006 | Every non-public route without a token, with a malformed, wrongly signed or expired token → `401 UNAUTHORIZED`.                                  |
| AUTH-007 | `GET /me` → the user (`id`, `email`, `createdAt`) and all memberships (`workspaceId`, `workspaceName`, `workspaceSlug`, `role`).                 |

## TEN: tenancy and isolation

| Id      | Requirement                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEN-001 | A caller who is not a member of `{workspaceId}` gets `404 WORKSPACE_NOT_FOUND` on every workspace route, for existing and non-existing workspaces alike. |
| TEN-002 | A non-UUID `{workspaceId}` → 404 (never 500).                                                                                                            |
| TEN-003 | A member of workspace A requesting a product/order id that belongs to workspace B under A's path → 404 (`PRODUCT_NOT_FOUND` / `ORDER_NOT_FOUND`).        |
| TEN-004 | Lists (`products`, `orders`, `members`, `events`) never contain rows of another workspace.                                                               |
| TEN-005 | An order cannot reference a product of another workspace (TEN-003 + DB composite FK).                                                                    |
| TEN-006 | Any query on a tenant table without a tenant in context fails (500), never returns data.                                                                 |
| TEN-007 | The user who belongs to both seeded workspaces sees each with its own role.                                                                              |
| TEN-008 | `GET /workspaces` lists only the caller's workspaces, with `myRole`.                                                                                     |

## PERM: permissions (member of the workspace)

| Action                                                 | VIEWER | MEMBER | ADMIN | OWNER |
| ------------------------------------------------------ | ------ | ------ | ----- | ----- |
| Read catalog, orders, order events, members, workspace | 200    | 200    | 200   | 200   |
| Create / edit draft order, place, cancel               | 403    | ✓      | ✓     | ✓     |
| Create / edit / archive products                       | 403    | 403    | ✓     | ✓     |
| Fulfill order                                          | 403    | 403    | ✓     | ✓     |
| Add member with role MEMBER or VIEWER                  | 403    | 403    | ✓     | ✓     |
| Add member with role ADMIN or OWNER                    | 403    | 403    | 403   | ✓     |

| Id       | Requirement                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| PERM-001 | Every cell of the table above holds; `403` has body `{ code: "FORBIDDEN", message: "Forbidden" }` without details. |
| PERM-002 | The permission check happens before the state check: a VIEWER cancelling a PAID order gets 403, not 422.           |
| PERM-003 | A 403 changes nothing (no write, no history, no version bump).                                                     |

## WS: workspaces and members

| Id     | Requirement                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| WS-001 | `POST /workspaces { name 1…100, slug 3…50 [a-z0-9-], currency ISO 4217, taxRateBps 0…5000 }` → 201; the creator becomes OWNER.          |
| WS-002 | A taken slug → `409 WORKSPACE_SLUG_TAKEN`.                                                                                              |
| WS-003 | `POST /members { email, role }`: unknown email → `404 USER_NOT_FOUND`; already a member → `409 ALREADY_MEMBER`; success → `201 { id }`. |
| WS-004 | `GET /members` lists members with `userId`, `email`, `role`, cursor-paginated.                                                          |

## CAT: catalog

| Id      | Requirement                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| CAT-001 | `POST /products { sku, name, description?, priceMinor }` → 201; product is ACTIVE.                                               |
| CAT-002 | `sku` 1…64 chars `[A-Za-z0-9._-]`, unique per workspace (`409 PRODUCT_SKU_TAKEN`); the same sku in another workspace is allowed. |
| CAT-003 | `priceMinor` integer 1…100 000 000; `name` 1…200; `description` ≤ 2000 or null.                                                  |
| CAT-004 | `PATCH /products/{id}` updates `name`, `description` (null clears), `priceMinor` → 204; `sku` is immutable (sending it → 400).   |
| CAT-005 | `POST /products/{id}/archive` → 204, status ARCHIVED; archiving again is a no-op 204. Products are never deleted.                |
| CAT-006 | `GET /products` newest first, `?status=ACTIVE                                                                                    | ARCHIVED`, cursor pagination as ORD-023. |
| CAT-007 | Product `price` is returned as money in the workspace currency.                                                                  |

## VAL: validation and API contract

| Id      | Requirement                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VAL-001 | Unknown fields in any body or query → `400 VALIDATION_FAILED` with `details.fields[] = { path, code, message }` (dot paths with array indices, e.g. `items.0.quantity`). |
| VAL-002 | Malformed JSON → 400; body > 10 kB → 413.                                                                                                                                |
| VAL-003 | Every documented status code in `/docs-json` is the only set of codes an operation returns (Schemathesis).                                                               |
| VAL-004 | Responses match their documented schema: all declared fields present, `null` where absent; dates ISO-8601 UTC.                                                           |
| VAL-005 | `Location` header on every 201 (new resource) and 202 (the order).                                                                                                       |
