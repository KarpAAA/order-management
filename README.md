# Order management: a multi-tenant backend, built step by step

A learning and portfolio project: a **multi-tenant order management backend** (workspaces,
users with roles, a product catalog, orders with an asynchronous payment flow) that grows one
area at a time: testing, database scaling, microservices and brokers, observability,
Kubernetes, load and chaos testing, AI.

**Current state: Step 3, microservices and brokers (3.10).** Four NestJS services that talk
through **RabbitMQ**: `services/api` (an HTTP **api** and a **worker**, two processes from one
image), `services/payments`, `services/inventory` and `services/notifications` (one broker
consumer each, with its own image and database). A tiny **fake-psp** (`devtools/fake-psp`)
plays an external payment provider, and **Mailpit** a mail server.

## Architecture in one minute

- **Modular monolith** with strict module boundaries: `identity` (users, workspaces,
  memberships, roles), `catalog` (products), `orders` (lifecycle, calculations, payment).
  Modules talk only through facades; ESLint enforces it.
- **Tenancy**: every workspace is a tenant. Tenant tables have composite keys
  `(workspace_id, id)`; tenant filtering happens in exactly one place (a Prisma extension).
  A caller who is not a member of a workspace always gets 404.
- **Payments**: `place` → `PENDING_PAYMENT` → `202`; in the same transaction the api writes the
  command `payments.charge-payment` to its outbox, and the relay of the worker publishes it
  (ADR 0014: no message is published next to a commit, in either service). payments-service
  charges the PSP once (idempotency key per attempt; a call of 2 s is made again up to twice
  within the delivery, and not at all while a circuit breaker holds the provider for down,
  ADR 0020) and answers with `payments.payment-succeeded` or
  `payments.payment-failed`; the worker of the api turns that into `PAID` or
  `PAYMENT_FAILED`. The messages are versioned contracts in `packages/contracts`. In
  payments the PSP sits behind a port with an HTTP adapter and an in-process fake.
- Money is BigInt minor units (JSON: `{ amountMinor, currency }`), ids are UUIDv7 from the
  domain, time comes from an injected `Clock`.

Details, diagrams (target architecture, modules, ERD, state machine, payment sequence) and
**known gaps**: [`docs/architecture.md`](docs/architecture.md).
Requirements for Step 1 tests: [`docs/requirements.md`](docs/requirements.md).
Decisions: [`docs/adr/`](docs/adr).

## Stack

Node.js 24 LTS · TypeScript 6 (strict) · pnpm 10 workspaces · NestJS 12 · Prisma 7 ·
PostgreSQL 18 · Redis 7 · BullMQ 6 · RabbitMQ 4 · class-validator · zod (env) · nestjs-cls · Swagger ·
bull-board · argon2 + JWT.

PostgreSQL **18**, not 17: the roadmap adds Citus (2.11, deferred to the second pass), and
Citus 14 (Feb 2026) supports PG 18.

## Quick start (Windows CMD)

Prerequisites: Docker Desktop running, **Node 24** (`.node-version`), pnpm 10.

```cmd
pnpm install
copy services\api\.env.example services\api\.env
copy services\payments\.env.example services\payments\.env
copy services\inventory\.env.example services\inventory\.env
copy services\notifications\.env.example services\notifications\.env
pnpm infra:up
pnpm db:migrate
pnpm db:migrate:payments
pnpm db:migrate:inventory
pnpm db:migrate:notifications
pnpm db:seed
pnpm db:seed:inventory
pnpm dev
```

- `pnpm infra:up`: Postgres, its read replica, PgBouncer, the Postgres of payments, of
  inventory and of notifications, Redis, RabbitMQ, Mailpit, the observability stack (`lgtm`) and fake-psp, waits until healthy. The replica's first start copies the whole primary.
- Grafana with Loki, Tempo and Prometheus behind it runs as one container (`lgtm`, ADR 0024)
  on port 3001. Every process sends its traces there (ADR 0025): Explore → Tempo → Search
  shows one trace per placed order, from the request to the mail, across `oms-api`,
  `oms-worker`, `oms-inventory`, `oms-payments` and `oms-notifications`. The log lines are
  there too (ADR 0026): Explore → Loki → `{service_name=~"oms-.+"} | detected_level="error"`,
  open a line, and the button beside its `trace_id` shows the trace of that request; from a
  span, "Logs for this span" goes back. `| correlationId="<x-correlation-id>"` finds
  everything an order caused. Under `pnpm dev` a process sends its lines itself
  (`OTEL_LOGS_EXPORTER=otlp` in its `.env`); in the `app` profile the agent `alloy` reads the
  stdout of the containers. Metrics (4.5) are not sent yet. What it keeps is in the volume
  `oms_lgtm-data`.
- Two database roles (ADR 0006): `pnpm db:*` connect as the owner `oms`
  (`DATABASE_ADMIN_URL`); api and worker connect as `oms_app` (`DATABASE_URL`), which sees only
  the rows of the current workspace (Row-Level Security). A fresh Postgres volume gets the
  login of `oms_app` from `devtools/postgres/init`. A volume created earlier needs it once,
  after `pnpm db:migrate`:
  `docker compose exec postgres psql -U oms -d oms -c "ALTER ROLE oms_app LOGIN PASSWORD 'oms_app'"`
- PgBouncer (ADR 0008) pools the connections of `oms_app` in transaction mode on port 6432.
  api and worker connect through it, under `pnpm dev` and in the containers alike
  (`DATABASE_URL`); the owner (`DATABASE_ADMIN_URL`, port 5432) never does.
- The catalog's product and list reads are cached in Redis (ADR 0010) for
  `CATALOG_CACHE_TTL_SECONDS` (300; 0 switches the cache off). A change through the API is
  visible at once; `pnpm db:seed`, `db:reset` and `db:datagen` write past the API, so after
  them a product read before may show its old row until the TTL. To clear the cache now:
  `docker compose exec redis sh -c "redis-cli --scan --pattern 'cache:*' | xargs -r redis-cli del"`
- A streaming read replica (ADR 0009) on port 5433 serves `GET` requests
  (`DATABASE_REPLICA_URL`, through PgBouncer's `oms_replica` pool); a user who has just written
  reads the primary until the replica has replayed that write. Without the variable every read
  goes to the primary. A fresh Postgres volume lets the replica in by itself
  (`devtools/postgres/init/02-replication.sh`); a volume created earlier needs the three
  commands at the top of that file once. A replica that was stopped for too long is rebuilt:
  `docker compose rm -sf postgres-replica`, `docker volume rm oms_postgres-replica-data`,
  `pnpm infra:up`.
- payments-service has its own Postgres on port 5434 (ADR 0012) and two roles as well:
  `pnpm db:migrate:payments` connects as the owner `payments`, the service as `payments_app`.
  A fresh volume gets that login from `devtools/postgres-payments/init`.
- RabbitMQ carries the command from the api to payments and the answer back. Its management
  UI shows the exchanges (`commands`, `events`), the queues (`payments.commands`,
  `api.payment-events`), their bindings and the messages on the way. Stop payments, place an
  order and the command waits in `payments.commands`; start it and the order becomes `PAID`.
- Each of the two queues has two more beside it (ADR 0013): `<queue>.wait.30000`, where a
  message whose handling failed waits for its next delivery, and `<queue>.dlq`, where it is
  parked when it is given up. Things to try, with the management UI open:
  - `docker compose stop fake-psp`, place an order: the command moves between
    `payments.commands` and its wait queue every 30 s. Start fake-psp before the fourth
    delivery and the order becomes `PAID`; leave it down and it becomes `PAYMENT_FAILED`
    with `psp_unavailable`. Place a few orders at once and the log of payments says
    `psp circuit opened`: from then on a delivery makes no call at all (ADR 0020).
  - Publish any text to the exchange `commands` with the routing key
    `payments.charge-payment`: it is in `payments.commands.dlq` at once, with the reason in
    the header `x-last-error`.
  - Kill the payments process while a charge is under way (`latencyMs` of fake-psp below
    3000 gives the time): the command goes from Unacked back to Ready, and the restarted
    process charges once.
  - A parked message is put back with "Move messages" on the page of its dead-letter queue
    (destination: the queue named in `x-parked-from`).
- A broker that still has the two queues from before 3.3 refuses to start the consumers
  (`PRECONDITION_FAILED`: the queue type cannot be changed). Once:
  `docker compose exec rabbitmq rabbitmqctl delete_queue payments.commands` and the same
  for `api.payment-events`.
- A message reaches the broker through the outbox of its service (ADR 0014): a row of the
  table `outbox`, written with the change, published by the relay in the worker within a
  second. Things to try:
  - `docker compose stop rabbitmq`, place an order: the answer is still 202, and
    `SELECT routing_key, published_at FROM outbox ORDER BY id DESC LIMIT 2` (database `oms`)
    shows the command and `orders.order-placed` with no `published_at`. The worker logs
    `outbox relay stuck` once. `docker compose start rabbitmq`: the rows get their
    `published_at`, the order becomes `PAID`.
  - Stop the worker (`pnpm dev` runs it; or `docker compose stop worker` in the `app`
    profile) and place an order: the same, with the broker up. The api process never
    publishes.
  - Bind a queue to the exchange `events` with the routing key `orders.*` in the management
    UI: every order now leaves `orders.order-placed`, `-paid`, `-cancelled`, `-fulfilled` there.
- A message takes effect once per consumer (ADR 0015): the consumer records its id in the
  table `inbox`, in the transaction of what the message causes. To see it, publish the same
  `payments.payment-succeeded` several times from the management UI (exchange `events`): the
  worker logs `skipped: duplicate` for every copy after the first, and
  `SELECT * FROM inbox` (database `oms`) has one row for it. `INBOX_RETENTION_DAYS` is how
  long a record is kept.
- `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_PUBLISH_TIMEOUT_MS` and
  `OUTBOX_RETENTION_DAYS` tune the relay; `OUTBOX_RELAY_ENABLED=false` stops it.
- `RABBITMQ_RETRY_DELAY_MS`, `PAYMENTS_COMMANDS_MAX_ATTEMPTS` (payments) and
  `PAYMENT_EVENTS_MAX_ATTEMPTS` (api) set the delay and the number of deliveries; a queue can
  have a delay of its own (`.env.example` of each service).
- inventory-service has its own Postgres on port 5435 (ADR 0016), with the roles `inventory`
  (owner) and `inventory_app`. `pnpm db:seed:inventory` gives the seeded products their stock.
  Stock itself still arrives by a command nobody sends: publish `inventory.adjust-stock` from
  the management UI (exchange `commands`, routing key = the `name` of the message, payload as
  in `packages/contracts/src/inventory/`) and watch `stock_items`.
- notifications-service has its own Postgres on port 5436 (ADR 0019), with the roles
  `notifications` (owner) and `notifications_app`. It writes to the user who created an order
  when something happens to it, and the mails end in **Mailpit**: http://localhost:8025.
  Things to try:
  - place an order as `member@acme.test`: "We received your order", then "Your order is paid".
    Cancel one as the admin: the mail still goes to the member, who created it;
  - `curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"declineRate\":1}"`
    and place again: "The payment for your order did not go through". An order for more than
    the stock holds: "Your order could not be placed";
  - `docker compose stop mailpit`, place an order, and watch its row in `notifications`
    (database `notifications`): `PENDING`, `send_attempts` grows, `last_error` says why.
    `docker compose start mailpit` before the fifth try and the mail arrives; after it the
    row is `FAILED` and stays so;
  - stop notifications, place a few orders, start it: the events waited in
    `notifications.order-events`, and every mail arrives once;
  - what the inbox is for (3.5): in the RabbitMQ management UI take a message of
    `notifications.order-events` with "Get messages" and requeue, or publish the same JSON
    twice to the exchange `events`. One mail. `SELECT * FROM inbox` has one row for its id.
- Placing an order is a saga (ADR 0017): the api reserves the stock, then asks for the
  charge, and undoes what was done when a step fails. `GET …/orders/{id}/events` tells the
  steps; `SELECT step, deadline_at FROM order_sagas` (database `oms`) says where a saga
  stands. Things to try, with all four processes running:
  - success: place an order. History: `ORDER_PLACED`, `STOCK_RESERVED`, `PAYMENT_SUCCEEDED`;
    `reserved` of the product went up in `stock_items` (database `inventory`).
  - declined: an order whose total ends in 13 minor units with `PAYMENT_GATEWAY=fake`, or
    `declineRate: 1` at fake-psp. `PAYMENT_FAILED`, then `STOCK_RELEASED`, and `reserved` is
    back where it was.
  - out of stock: order more than the product has. The order is a `DRAFT` again with
    `failureReason: out_of_stock`, and the history names the shortage. Nothing was charged.
  - payments is down: stop the payments process and place an order. After
    `ORDER_SAGA_CHARGE_TIMEOUT_MS` the history has `PAYMENT_TIMED_OUT` and the order still
    waits: the api asked payments to cancel the charge and cannot know more. Start payments:
    the charge command has expired, so nothing is charged; `PAYMENT_FAILED` with `expired`,
    then `STOCK_RELEASED`.
  - inventory is down: stop it and place an order. After `ORDER_SAGA_RESERVE_TIMEOUT_MS` the
    order is a `DRAFT` again with `inventory_unavailable`.
  - cancel while the charge is under way (`latencyMs` of fake-psp gives the time): 202, then
    `CANCELLED` with `CANCELLATION_REQUESTED` in the history, or `PAID` when the charge was
    first. Seeded order 3 (`PENDING_PAYMENT`) can be cancelled this way too.
  - the timeouts wait in the broker: the queues `api.saga-timeouts.delay.<ms>` in the
    management UI hold one message per step that is waiting. Set the three
    `ORDER_SAGA_*_TIMEOUT_MS` to a few seconds to watch them go off.
- `pnpm db:explain:resilience`: one call, a retry, and a retry with a circuit breaker
  against a provider that is healthy, fails, is down and hangs
  (`docs/perf/3.11-resilience.md`, which also says what the client sees meanwhile)
- `pnpm db:explain:stock`: the last unit and 50 buyers under four locking strategies
  (`docs/perf/3.6-stock-locking.md`).
- `pnpm dev`: the contracts in watch mode, then api, worker, payments, inventory and
  notifications, side by side.
- `POST …/orders` and `POST …/orders/{id}/place` need an `Idempotency-Key` header, a uuid of
  the client's choosing (ADR 0018). Send the same request twice with the same key: one order,
  the same answer. Another body with that key: 422. `SELECT scope, status_code, response FROM
idempotency_keys` (database `oms`) shows what is remembered, for `IDEMPOTENCY_RETENTION_HOURS`.
- Then open `docs/requests.http` in WebStorm and run it top to bottom.

Everything in containers instead (api and worker from **one** image, payments, inventory and
notifications each from its own, migrations as a one-shot step before each):

```cmd
docker compose --profile app up --build
```

Other scripts: `pnpm build`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm db:reset`,
`pnpm infra:down`.

## URLs

| What                          | URL                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| API                           | http://localhost:3000/v1                                                                                                                   |
| Swagger UI                    | http://localhost:3000/docs                                                                                                                 |
| OpenAPI JSON                  | http://localhost:3000/docs-json                                                                                                            |
| bull-board (queues, dev only) | http://localhost:3000/admin/queues                                                                                                         |
| RabbitMQ management           | http://localhost:15672 (guest / guest)                                                                                                     |
| Mailpit (the mails sent)      | http://localhost:8025                                                                                                                      |
| Grafana                       | http://localhost:3001 (no login; `admin` / `admin` to sign in). OTLP: `localhost:4317` (gRPC), `4318` (HTTP)                               |
| Dashboards                    | http://localhost:3001/dashboards → folder OMS: `OMS · System`, `OMS · SLO`; the alert: Alerting → Alert rules. Traffic: `pnpm demo:orders` |
| Metrics of a process          | `curl localhost:9464/metrics` (api), 9465 (worker), 9466 (payments), 9467 (inventory), 9468 (notifications)                                |
| fake-psp                      | http://localhost:4010 (`GET /charges`, `POST /charges/{id}/void`, `POST /admin/config`, `POST /admin/reset`)                               |
| PgBouncer console             | `psql postgresql://stats:stats@localhost:6432/pgbouncer -c "SHOW POOLS"`                                                                   |
| Replication state             | `psql postgresql://oms:oms@localhost:5432/oms -c "TABLE pg_stat_replication"`                                                              |

## Seeded data

Every user's password is **`Passw0rd!`**.

| Workspace | Id                                     | Currency | Tax             |
| --------- | -------------------------------------- | -------- | --------------- |
| acme      | `01990000-0000-7000-8000-a00000000000` | EUR      | 2000 bps (20 %) |
| globex    | `01990000-0000-7000-8000-b00000000000` | USD      | 0               |

| User               | Id                                     | acme   | globex |
| ------------------ | -------------------------------------- | ------ | ------ |
| owner@acme.test    | `01990000-0000-7000-8000-c000000000a1` | OWNER  | –      |
| admin@acme.test    | `01990000-0000-7000-8000-c000000000a2` | ADMIN  | –      |
| member@acme.test   | `01990000-0000-7000-8000-c000000000a3` | MEMBER | –      |
| viewer@acme.test   | `01990000-0000-7000-8000-c000000000a4` | VIEWER | –      |
| owner@globex.test  | `01990000-0000-7000-8000-c000000000b1` | –      | OWNER  |
| admin@globex.test  | `01990000-0000-7000-8000-c000000000b2` | –      | ADMIN  |
| member@globex.test | `01990000-0000-7000-8000-c000000000b3` | –      | MEMBER |
| viewer@globex.test | `01990000-0000-7000-8000-c000000000b4` | –      | VIEWER |
| both@example.test  | `01990000-0000-7000-8000-c000000000c1` | MEMBER | VIEWER |

**Products**: 18 per workspace, ids `…-a100000000NN` (acme) and `…-b100000000NN` (globex)
where `NN` = 01…12 in hex (1…18); SKUs `ACM-001…018` / `GBX-001…018`. Products 4, 11 and 16
(`…04`, `…0b`, `…10`) are **ARCHIVED**.

**Orders**: the same set in each workspace, ids `…-a2000000000N` (acme) / `…-b2000000000N` (globex):

| N   | Status          | Notes                                                     |
| --- | --------------- | --------------------------------------------------------- |
| 1   | DRAFT           | 1 item                                                    |
| 2   | DRAFT           | no items (placing it → 422)                               |
| 3   | PENDING_PAYMENT | seeded past `place`: no command in the outbox, stays so   |
| 4   | PAID            | 2 items, 10 % discount                                    |
| 5   | PAYMENT_FAILED  | `insufficient_funds`, FIXED discount; can be placed again |
| 6   | FULFILLED       | full history                                              |
| 7   | CANCELLED       | cancelled from DRAFT                                      |

## Generated data (Step 2)

A volume dataset for the Step 2 experiments (indexes, partitioning, tenancy modes, sharding),
loaded **next to** the seed after a reset:

```
pnpm db:reset
pnpm db:datagen                      # full: 100 tenants, 2M orders, 24 months (~6 GB, minutes)
pnpm db:datagen --scale smoke        # 10 tenants, 20k orders, 6 months (seconds)
```

Flags: `--seed 42`, `--until <ISO date>` (default today 00:00 UTC, printed at start),
`--tenants`, `--orders`, `--months`. The same `--seed` and `--until` give byte-identical data.

- **Tenants** `gen-001…gen-100` follow a Zipf distribution: `gen-001` holds ~20 % of all
  orders, the long tail a few hundred each. Late tenants join during the window.
- **Orders** are built through the domain (`Order.draft` + real transitions + `OrderMapper`),
  so totals, CHECKs and history always match the status. Order times grow denser towards
  `until` and are loaded in time order with tenants interleaved, as production writes them.
  Ids are UUIDv7 stamped with the row's own `created_at`.
- **Users**: `owner@gen-001.datagen.local`, `user-01@gen-001.datagen.local`, … with the seed
  password. The last user of each tenant is a VIEWER.
- `order_events` is partitioned by month: the script creates the partitions of the whole
  window before loading (the migration and the worker job only cover the months around today).
- Loaded with `COPY` in 5000-order transactions, then `VACUUM ANALYZE`; the script prints
  table and index sizes (partitions summed into `order_events`, then one line per partition),
  the top tenants and the status mix. It refuses production, a non-local
  host, and a database that already has `gen-*` tenants.

Sizes later on (every `order_events_YYYY_MM` partition is its own line):

```sql
SELECT relname, n_live_tup,
       pg_size_pretty(pg_relation_size(relid))       AS heap,
       pg_size_pretty(pg_indexes_size(relid))        AS indexes,
       pg_size_pretty(pg_total_relation_size(relid)) AS total
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;
```

Plans on this data: `pnpm db:explain` (lists, `docs/perf/2.2-indexes-explain.md`),
`pnpm db:explain:partitions` (pruning, DROP vs DELETE, `docs/perf/2.3-partitioning.md`),
`pnpm db:explain:rls` (what the application role sees, plans under the policy,
`docs/perf/2.4-rls.md`), `pnpm db:explain:pgbouncer` (500 clients on 20 server connections,
the two connection limits, a session-level setting leaking, `docs/perf/2.7-pgbouncer.md`),
`pnpm db:explain:replica` (replication lag, the same read on both servers, read-your-writes
with a replica 5 s behind, `docs/perf/2.8-read-replica.md`) and `pnpm db:explain:cache` (the
catalog cache: a hit against a database read, hit ratio, 200 callers on an empty key,
`docs/perf/2.9-cache.md`).

## Simulating the payment provider

fake-psp reads `FAKE_PSP_LATENCY_MS`, `FAKE_PSP_FAILURE_RATE`, `FAKE_PSP_THROTTLE_RATE`,
`FAKE_PSP_DECLINE_RATE` at start
(see `docker-compose.yml`) and can be changed at runtime without a restart:

```cmd
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"declineRate\":1}"
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"failureRate\":1,\"declineRate\":0}"
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"latencyMs\":4000}"
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"latencyMs\":200,\"failureRate\":0,\"declineRate\":0}"
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"failureRate\":0.5}"
curl -X POST http://localhost:4010/admin/config -H "content-type: application/json" -d "{\"throttleRate\":0.5}"
curl http://localhost:4010/charges
curl http://localhost:4010/admin/stats
```

- `declineRate: 1`: every new charge is declined → `PAYMENT_FAILED` with the decline code, no
  retry. Place the order again: a new attempt, a new idempotency key.
- `failureRate: 1`: every call returns 503 → three calls within the delivery, then the
  command is delivered again every 30 s, and the fourth delivery ends the attempt:
  `PAYMENT_FAILED` with `psp_unavailable` after about 90 s. Set `failureRate` back to 0 in
  between and the order becomes `PAID`. Once more than 80 % of at least ten calls in 10 s
  have failed the circuit opens and `GET /admin/stats` stops counting: payments has stopped
  calling.
- `failureRate: 0.5`: most orders are `PAID` at once, the retry hides the failure, and the
  circuit stays closed. Start payments with `PSP_BREAKER_THRESHOLD=0.5` and
  `PSP_BREAKER_MIN_CALLS=5` to see it open on this provider, and the orders wait for their
  next deliveries (`docs/perf/3.11-resilience.md`).
- `throttleRate`: that share of the calls gets a 429 with `Retry-After: 1`; payments waits
  that second and calls again.
- `latencyMs` above 2000: the 2 s timeout of a call fires → handled like a failure, and an
  operation ends after 7 s whatever its calls are doing.
- `GET /admin/stats`: the calls the provider got since the last `POST /admin/reset`, by status,
  and `inFlight`: the calls it has taken and not answered yet.
- The same `Idempotency-Key` always returns the same response.

Set `PAYMENT_GATEWAY=fake` in `services/payments/.env` to skip fake-psp entirely (in-process,
deterministic: amounts ending in `13` minor units are declined).

## Message contracts

```cmd
pnpm contracts:freeze  & rem release the contracts: writes the schema and a sample of a new version
pnpm contracts:check   & rem the released versions against the base branch (the CI job `contracts`)
```

Every version of a message between the services is kept in `packages/contracts/released/`: its
JSON Schema and one message as it was written on the day of the release. `pnpm test` compares
each contract with its released version and holds each service to the map of who writes a
contract and who reads it (`packages/contracts/src/parties.ts`, ADR 0021).

To see it: rename a field in `packages/contracts/src/orders/order-paid.v1.ts` and fix what the
typecheck asks for. `pnpm --filter @oms/contracts test` still fails (`payload.chargeId:
removed`), and `pnpm contracts:freeze` refuses and names the file a new version goes into.
A released version takes one change: a field that is not required.

## Contract fuzzing (Schemathesis)

```cmd
pnpm test:contract     & rem fresh stack + seed in project oms-contract, then Schemathesis
pnpm contract:down     & rem remove the project and its volumes
```

Schemathesis generates requests from `/docs-json` and checks every response: no 5xx, only
documented status codes, bodies matching the schema, and the API accepting what the schema
allows (and rejecting what it forbids). It runs in its own compose project with no host
ports, so it works next to the dev stack and never touches dev data. The containers stay up
after a run for `docker compose -p oms-contract logs api`.

Config: `devtools/contract/schemathesis.toml`. It logs in as `owner@acme.test` by itself,
pins `workspaceId` to acme (a random one is a non-member → 404 at the guard) and draws
`orderId` / `productId` mostly from the seeded ids. Every failure prints a `curl` to reproduce it.

## System tests

```cmd
pnpm test:system       & rem fresh stack in project oms-system, both seeds, four scenarios
pnpm system:down       & rem remove the project and its volumes (after SYSTEM_KEEP_STACK=1)
```

All four services from their images (`docker-compose.system.yml`: the `app` profile, plus the
two seeds), and an order sent through them four times: paid; declined and placed again; out
of stock; cancelled while its charge is under way. The test (`devtools/system`) runs on the
host and knows what a client and an operator know: the HTTP API (port 3100), what the
provider was asked to charge (4110) and the mailbox of the user (8125). It stands next to the
dev stack and never touches dev data.

A run removes the volumes, builds the images, waits until every queue has its consumer and
removes the stack again: about two minutes with the images built, of which twenty seconds
are the scenarios (`docs/perf/3.13-system-tests.md`). The logs of every container are in
`devtools/system/reports/stack.log` afterwards. `set SYSTEM_KEEP_STACK=1` leaves the stack up
to look at; the next run starts from nothing all the same, the scenarios spend the seeded
stock. Why four scenarios and not the suite of every service again: ADR 0022.

## Mutation testing (Stryker)

```cmd
pnpm test:mutation     & rem Stryker over the unit suite, report in services/api/reports/mutation
```

Stryker plants small bugs (mutants) in `orders` `domain/` + `application/` and in
`shared/domain/money.ts`, runs the unit tests covering each one, and reports the mutants no
test caught. A surviving mutant is a missing or too weak assertion. Report only for now: no
threshold fails the run. Repeated runs are incremental (`reports/stryker-incremental.json`).
Config: `services/api/stryker.config.mjs`.

## Migration checks

```cmd
pnpm test:migrations   & rem guard, fresh, drift, upgrade on a throwaway Postgres (Testcontainers)
```

Four steps against the merge base with `main` (`MIGRATIONS_BASE_REF` overrides the ref); the
first failure stops the run:

- **guard** (git only): no migration of the base edited, deleted or renamed, uncommitted
  edits included; new migrations sort after the base's last one. More than one new
  migration is a warning (one migration per PR).
- **fresh**: `prisma migrate deploy` of every migration on an empty database.
- **drift**: `prisma migrate diff` of that database against `schema.prisma`; on a
  difference it prints the SQL still missing (a forgotten `prisma migrate dev`). The
  hand-written CHECKs, roles, grants, policies and functions are invisible to it; the
  `*.int-spec.ts` tests cover them.
- **upgrade**, only when the branch adds migrations: a git worktree of the base installs,
  migrates and runs its own `prisma/seed.ts`, then this branch's new migrations run on top.
  Catches SQL that passes on an empty table and fails on data (`ADD COLUMN … NOT NULL`
  without a default).

Script: `services/api/prisma/check-migrations.ts`.

## CI and git hooks

Each check runs at the cheapest level that can catch its bug; a hook is a shortcut, CI is the
gate (a hook can be skipped, CI cannot).

| When                             | What                                                                                   | Where                            |
| -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- |
| `git commit`                     | Prettier + ESLint `--fix` on staged files                                              | `.husky/pre-commit`, lint-staged |
| `git commit`                     | Conventional Commits (`commitlint.config.mjs`), no `Co-Authored-By` / `Claude-Session` | `.husky/commit-msg`              |
| `git push`                       | `pnpm typecheck && pnpm test`                                                          | `.husky/pre-push`                |
| every PR, every push to `main`   | static (format, lint, typecheck) → unit → e2e + migrations; audit; commits (PR)        | `.github/workflows/ci.yml`       |
| push to `main`, nightly, by hand | Stryker (incremental, report artifact), Schemathesis, system tests (logs artifact)     | `.github/workflows/nightly.yml`  |
| weekly                           | dependency PRs, each through the full CI                                               | `.github/dependabot.yml`         |

Hooks install with `pnpm install` (`prepare`). By hand only: e2e and migration checks before
pushing a change to repositories or `schema.prisma`, `pnpm test:contract` while fixing DTOs,
`pnpm test:system` after a change to a compose file, a Dockerfile or the topology of the broker,
Stryker on one file (`pnpm --filter @oms/api exec stryker run --mutate <file>`).

**Stock** (`pnpm db:seed:inventory`, the database of inventory): 100 units on hand of every
seeded product in both workspaces, except product 18 (`…12`), which has **one** unit, and
product 17 (`…11`), which has no stock item at all. The seed keeps the levels of a product
that already has stock.

## Repository layout

```
services/api/        NestJS service: src/entrypoints/main.api.ts + main.worker.ts, one image
  prisma/            schema, migrations, seed
  src/entrypoints/   one module + one main per process
  src/config/        zod-validated env, typed namespaces
  src/common/        HTTP frame: guards, filter, decorators, DTOs, tenant context
  src/shared/        framework-free: errors, Actor, Money, Clock, ids, events, pagination
  src/infrastructure/ database (tenant choke point), queues, messaging (broker), outbox, inbox, events
  src/modules/       identity (L1), catalog (L1), orders (L4)
services/payments/   NestJS service: src/entrypoints/main.worker.ts, its own image and database
  prisma/            schema and migrations of the payments database
  src/modules/       payments (L1): one use case, the gateway and publisher ports
services/inventory/  NestJS service: src/entrypoints/main.worker.ts, its own image and database
  prisma/            schema, migration and seed of the inventory database; explain/locking.ts
  src/modules/       inventory (L4): stock and reservations, three use cases
services/notifications/ NestJS service: src/entrypoints/main.worker.ts, its own image and database
  prisma/            schema and migration of the notifications database
  src/modules/       notifications (L4): a mail per order event, written as a row, then sent
packages/contracts/  message contracts between services: versioned zod schemas, exchange
                     names (ADR 0011, ADR 0012); released/ and the map of parties (ADR 0021)
devtools/fake-psp/   external PSP simulator (not part of the system)
devtools/system/     system tests: the stack of docker-compose.system.yml through its HTTP API (ADR 0022)
docs/                architecture, requirements, ADRs, conventions backlog, requests.http
```
