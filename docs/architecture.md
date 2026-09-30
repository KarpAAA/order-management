# Architecture

A multi-tenant order management backend that grows one step at a time. This document
describes the **target** architecture and marks what exists after **Step 0**.

## 1. Target architecture

```mermaid
flowchart LR
  client([HTTP client]) --> api

  subgraph apiSvc["api service: one image, two processes"]
    api["api<br/>(main.api.ts)<br/>identity · catalog · orders"]
    worker["worker<br/>(main.worker.ts)<br/>BullMQ consumers"]
  end

  api -- "BullMQ job (Redis)" --> worker
  api --> pg[("PostgreSQL<br/>api db")]
  worker --> pg
  worker -- "HTTP, idempotent" --> psp["fake-psp<br/>(external PSP simulator)"]

  subgraph later["Step 3+ (not built yet)"]
    payments["payments-service"]
    inventory["inventory-service"]
    notifications["notifications-service"]
    analytics["analytics-service"]
    rabbit{{RabbitMQ<br/>commands}}
    kafka{{Kafka<br/>domain events}}
  end

  api -. "ChargePayment / ReserveStock" .-> rabbit
  rabbit -.-> payments & inventory & notifications
  api -. "OrderPlaced, OrderPaid…" .-> kafka
  kafka -.-> analytics & notifications
  payments -.-> psp

  classDef built fill:#d8f5d0,stroke:#3a7d2c;
  classDef future fill:#eee,stroke:#999,stroke-dasharray: 4 3;
  class api,worker,pg,psp built;
  class payments,inventory,notifications,analytics,rabbit,kafka future;
```

| Component               | Responsibility                                                                  | Status     |
| ----------------------- | ------------------------------------------------------------------------------- | ---------- |
| `api` (HTTP)            | identity & tenancy, catalog, orders; later orchestrates the order saga          | **Step 0** |
| `api` worker            | background jobs (BullMQ): payment charging; later saga timeouts, scheduled jobs | **Step 0** |
| `fake-psp`              | simulated external payment provider (`devtools/`, not part of the system)       | **Step 0** |
| `payments-service`      | payments, idempotent charges and refunds against the PSP                        | Step 3     |
| `inventory-service`     | stock levels, reservations                                                      | Step 3     |
| `notifications-service` | emails on order events                                                          | Step 3     |
| `analytics-service`     | read-model aggregates from Kafka events                                         | Step 3     |

Target communication: **RabbitMQ** for commands and replies between services, **Kafka** for
the domain event log, **BullMQ** for jobs inside one service, **PostgreSQL** database per
service.

## 2. Process model

- One repository, one image (`services/api/Dockerfile`), two entrypoints:
  `src/entrypoints/main.api.ts` (HTTP) and `main.worker.ts` (queue consumers, no HTTP).
- Every business module is a **core module** (domain, application, persistence, read side)
  plus one **transport module** per transport (`*.http.module.ts`, `*.worker.module.ts`).
  Only transport modules reach an entrypoint; anything that starts on its own (the
  `@Processor`) lives only in `orders.worker.module.ts`, imported only by `WorkerModule`.
- Migrations are a separate one-shot step (`migrate` compose service), never part of `CMD`.

## 3. Modules and allowed dependencies

```mermaid
flowchart TB
  subgraph modules
    identity["identity<br/>L1 · CQS"]
    catalog["catalog<br/>L1 · CQS"]
    orders["orders<br/>L4 · CQS + EventBus"]
  end
  orders -- "IdentityFacade.getWorkspaceTerms" --> identity
  orders -- "CatalogFacade.findProductSnapshots" --> catalog
  catalog -- "IdentityFacade.getWorkspaceTerms (currency)" --> identity
  guard["common/WorkspaceAccessGuard"] -- "MEMBERSHIP_READER port" --> identity
```

- Modules talk only through facades (`index.ts` is the only import path, enforced by ESLint).
- Within `orders` (level 4) the layers are enforced by `eslint-plugin-boundaries`:
  `domain` imports nothing framework-related; `application` sees `domain`, `ports`,
  `common`, `shared` and other modules' `index.ts`; `infrastructure` implements `ports`.
- Ports in `orders`: `PaymentGateway` (HTTP adapter → fake-psp, fake in-process adapter,
  chosen by `PAYMENT_GATEWAY=http|fake`), `OrdersRepositoryPort`, `PaymentChargeScheduler`
  (BullMQ today, outbox in Step 3). Step 3 extracts payments by adding one more
  `PaymentGateway` adapter; domain and use cases do not change.

| Module   | Owns tables                             | Exposes                                               |
| -------- | --------------------------------------- | ----------------------------------------------------- |
| identity | `users`, `workspaces`, `memberships`    | `IdentityFacade` (membership lookup, workspace terms) |
| catalog  | `products`                              | `CatalogFacade` (product snapshots for orders)        |
| orders   | `orders`, `order_items`, `order_events` | nothing yet (no consumer)                             |

## 4. Data model

```mermaid
erDiagram
  users ||--o{ memberships : "user_id"
  workspaces ||--o{ memberships : "workspace_id"
  workspaces ||--o{ products : "workspace_id"
  workspaces ||--o{ orders : "workspace_id"
  users ||--o{ orders : "created_by"
  orders ||--|{ order_items : "(workspace_id, order_id)"
  products ||--o{ order_items : "(workspace_id, product_id)"
  orders ||--|{ order_events : "(workspace_id, order_id)"

  users { uuid id PK "global" text email UK "lower-case" text password_hash }
  workspaces { uuid id PK "global" text slug UK char3 currency int tax_rate_bps }
  memberships { uuid workspace_id PK uuid id PK uuid user_id enum role }
  products { uuid workspace_id PK uuid id PK text sku "UK with workspace_id" bigint price_minor enum status }
  orders { uuid workspace_id PK uuid id PK enum status char3 currency bigint total_minor int payment_attempt int version }
  order_items { uuid workspace_id PK uuid id PK uuid order_id FK uuid product_id FK bigint unit_price_minor int quantity }
  order_events { uuid workspace_id PK uuid id PK timestamptz created_at PK uuid order_id FK enum type text actor jsonb payload }
```

- **Global tables** `users`, `workspaces` (future Citus reference tables).
- **Tenant tables** have `workspace_id`, PK `(workspace_id, id)`, and FKs between them
  include `workspace_id`, so a row can never point into another tenant.
- `order_events` is append-only with PK `(workspace_id, id, created_at)` so Step 2 can
  range-partition it by `created_at` without changing the key. Not partitioned now.
- Money is `BIGINT` minor units; ids are UUIDv7 from the application; timestamps `timestamptz(3)`.
- Invariants the schema can express are `CHECK` constraints (hand-written in the first
  migration): price range, quantity range, line total, totals equation, discount shape.
- Indexes: only what Step 0 queries need (keyset lists by `(workspace_id, [status,]
created_at DESC, id DESC)`, FK columns, uniques).

## 5. Order state machine

```mermaid
stateDiagram-v2
  [*] --> DRAFT: create
  DRAFT --> PENDING_PAYMENT: place
  DRAFT --> CANCELLED: cancel
  PENDING_PAYMENT --> PAID: payment succeeded (worker)
  PENDING_PAYMENT --> PAYMENT_FAILED: declined / retries exhausted (worker)
  PAYMENT_FAILED --> PENDING_PAYMENT: place (new attempt)
  PAYMENT_FAILED --> CANCELLED: cancel
  PAID --> FULFILLED: fulfill
  FULFILLED --> [*]
  CANCELLED --> [*]
```

Items and discount change only in `DRAFT`. Every transition appends an `order_events` row
in the same transaction as the order update. Any other transition → `422`.

## 6. Payment flow

```mermaid
sequenceDiagram
  autonumber
  actor C as Client
  participant API as api (PlaceOrderService)
  participant DB as PostgreSQL
  participant Q as Redis (BullMQ)
  participant W as worker (OrdersConsumer)
  participant PSP as fake-psp

  C->>API: POST /orders/{id}/place { version }
  API->>DB: BEGIN; order → PENDING_PAYMENT, attempt++, insert ORDER_PLACED; COMMIT
  Note over API: OrderPlaced (in-process) fires after commit
  API->>Q: add charge-order, jobId charge-{id}-{attempt}
  Note over API,Q: NOT atomic with the commit (Known gap → Step 3 outbox)
  API-->>C: 202 { id, status: PENDING_PAYMENT } + Location
  Q->>W: charge-order { workspaceId, orderId, attempt }
  W->>DB: load order (tenant bound from job); still PENDING_PAYMENT with this attempt?
  alt stale or duplicate job
    W-->>Q: done, nothing happens
  else awaiting this attempt
    W->>PSP: POST /charges, Idempotency-Key {id}:{attempt}, timeout 3 s
    alt succeeded
      W->>DB: BEGIN; → PAID + PAYMENT_SUCCEEDED; COMMIT
    else declined
      W->>DB: BEGIN; → PAYMENT_FAILED (declineCode) + PAYMENT_FAILED; COMMIT
    else 5xx / timeout / network
      W-->>Q: throw → retry (5 attempts, exponential backoff)
      Note over W: last attempt → PAYMENT_FAILED (psp_unavailable)
    end
  end
  C->>API: GET /orders/{id} (poll until PAID / PAYMENT_FAILED)
```

The PSP call never runs inside a database transaction: `ProcessOrderPaymentService` has no
transaction; `CompleteOrderPayment` / `FailOrderPayment` each open their own.

## 7. Tenancy

- The tenant is the **workspace**. All workspace routes are `/v1/workspaces/{workspaceId}/…`.
- `AuthGuard` (global) validates the JWT and builds the `UserActor` (no roles on it).
- `WorkspaceAccessGuard` (`@WorkspaceScoped()`) loads the caller's membership through the
  `MEMBERSHIP_READER` port. **Not a member → 404**, for existing and non-existing workspaces
  alike. A member gets the tenant bound in CLS (`TenantContext`).
- Policies get the membership and decide **403**. The domain decides **422**.
- **Single choke point:** `infrastructure/database/tenant-scope.extension.ts`, a Prisma
  client extension on every tenant model: it adds `workspace_id = <tenant>` to every filter,
  checks that every write carries the same workspace, and throws when no tenant is bound.
  Repositories, query services and `@Transactional()` all use this scoped client.
- The worker binds the tenant from the job's `workspaceId` (`TenantContext.runInWorkspace`).
- Documented exceptions, all in `identity`: (1) the membership lookup the guard performs
  before a tenant exists, (2) "my workspaces" and `/me` (cross-tenant by nature), both via
  the unscoped `PrismaService`; (3) creating a workspace writes its OWNER membership as a
  nested create (the workspace does not exist before). Not covered by the extension:
  `$queryRaw` (none in the code base) and nested relation writes from global models.
- Step 2 replaces the extension's body with `SET LOCAL app.workspace_id` + Row-Level
  Security, and then schema-per-tenant; nothing outside `infrastructure/database/` changes.

## 8. Known gaps

| Gap                                                | Consequence today                                                                                                                                                      | Closed in                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Enqueue after commit is not atomic with the commit | If Redis is down or the process dies between commit and enqueue, the order stays `PENDING_PAYMENT` with no job                                                         | Step 3 (transactional outbox)                           |
| `PENDING_PAYMENT` cannot be cancelled              | A stuck order (see above) cannot be cancelled by users                                                                                                                 | Step 3 (saga with compensation)                         |
| Tenant isolation only in the application layer     | A bug that bypasses the scoped client (raw SQL, unscoped handle) could cross tenants                                                                                   | Step 2 (RLS, schema-per-tenant)                         |
| No caching, no rate limiting                       | Every request hits Postgres; brute force on `/auth/login` is not throttled                                                                                             | Step 2                                                  |
| Default Nest logger only                           | Unstructured logs, no correlation ids, no `correlationId` in error bodies                                                                                              | Step 4 (pino, OpenTelemetry)                            |
| No health checks, no graceful shutdown             | Compose/k8s cannot tell "started" from "ready"; in-flight jobs are cut on stop                                                                                         | Step 5                                                  |
| `Location` on two 201s points nowhere              | `POST /auth/register` and `POST /workspaces/{id}/members` return a `Location` without a GET route behind it                                                            | open: a GET route or another URL, decided with the API  |
| No `Idempotency-Key` on HTTP writes                | A retried `POST /orders` creates a second draft (place is protected by `version`)                                                                                      | Step 3 (with the saga)                                  |
| No reconciliation with the PSP                     | If every attempt times out after the PSP already charged (e.g. latency > 3 s), the order ends `PAYMENT_FAILED psp_unavailable` while the PSP holds a successful charge | Step 3 (payments-service reconciles by idempotency key) |
| Seeded `PENDING_PAYMENT` orders have no job        | They stay pending forever: a fixture that shows the first gap                                                                                                          | Step 3                                                  |
