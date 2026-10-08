# 0018 — A write that has no key of its own needs an Idempotency-Key, recorded in its transaction

Date: 2026-10-11 Status: accepted

## Context

A client that did not get the answer to a write sends it again: the connection dropped, a
proxy timed out, the user pressed the button twice. The server cannot tell "the same request
again" from "another one": the two are equal byte for byte.

Most writes of the API refuse the second attempt by themselves. A workspace has a unique
slug, a product a unique SKU, a member is in a workspace once: the repetition is a 409 and
nothing is duplicated. `cancel`, `fulfill`, `archive` and `PATCH` carry the `version` the
client saw, and the first attempt changed it. Two writes have nothing of the kind:

- **`POST /orders`** creates a draft from a list of items. Sent twice, it creates two
  (known gap since Step 0).
- **`POST /orders/{id}/place`** is protected by `version`, so the repetition is refused, but
  with a 409: a client that lost the 202 learns that "something changed", not that its order
  was placed. It is the write that starts the saga and ends in a charge
  (`http/api-conventions.md` §5 requires a key for those).

Between services the same problem was solved in 3.5: a consumer records the id of a message
in the transaction of what the message causes (ADR 0015). HTTP has no message id unless the
client sends one.

## Decision

- **`POST /orders` and `POST /orders/{id}/place` require the header `Idempotency-Key`**, a
  uuid the client chooses and repeats on every retry of that request. Without it, or with
  something that is not a uuid: `400 IDEMPOTENCY_KEY_REQUIRED`. Optional would protect only
  the clients that remember it.

- **The key and its answer are a row of `idempotency_keys`, written in the transaction of
  the write**: `(user_id, scope, key)`, a fingerprint of the body, the status and the body of
  the response. Committed with the order or not at all:

  | Order of the two writes            | A crash in between                                        |
  | ---------------------------------- | --------------------------------------------------------- |
  | the write, commit, then the key    | done, not recorded: the retry does it again               |
  | the key, commit, then the write    | recorded, never done: the retry gets an answer to nothing |
  | the key in Redis, beside the write | either of the two, depending on the order                 |
  | one transaction                    | none of the above                                         |

- **A key belongs to its user and its route**: `scope` is the method and the path of the
  request, which names the workspace and, for `place`, the order. The same key of another
  user, or on another path, is a key nobody has seen. So the table is not a tenant table:
  no `workspace_id`, no Row-Level Security, like `inbox`; a lookup always carries the user.

- **What the same key gets again**:
  - the same body → the stored status and body, and `Location` with them; the use case does
    not run;
  - another body → `422 IDEMPOTENCY_KEY_REUSED`. The fingerprint is a SHA-256 of the body
    with the keys of every object in one order, so `{a,b}` and `{b,a}` are one request;
  - while the first request is still being handled → `409 IDEMPOTENCY_KEY_IN_PROGRESS` with
    `Retry-After`. The second request does not wait for the first.

- **"Being handled" is a transaction-level advisory lock on the key**, taken first
  (`pg_try_advisory_xact_lock`). Not acquired means somebody is inside: no row has to be
  committed in advance to say so, and nothing has to be cleaned up when that request dies.
  The only kind of advisory lock PgBouncer in transaction mode allows (ADR 0008).

- **Only an answered write is remembered.** A request that is refused (validation, 403, 404,
  409, 422) or fails rolls its transaction back, and the key with it: the client corrects
  the request and sends the same key.

- **`@Idempotent()` on the route, an interceptor around the handler.** The interceptor opens
  the transaction, asks the store (`Idempotency.once()`, the port in `shared/http/`, like
  `Inbox.once()`), and the `@Transactional()` use case inside joins it. Route-level, not
  global: the transaction has to commit inside the global interceptors, which act on what
  was committed (the `Location` header, the read-your-writes marker of ADR 0009).

- **Kept for `IDEMPOTENCY_RETENTION_HOURS`, 24 by default.** A retry comes within seconds or
  minutes. An hourly BullMQ job on a queue of its own deletes older keys
  (`cleanup-idempotency-keys`), in the worker, like the cleanups of the outbox and the inbox.

## Rejected

- **The key on every creating `POST`** (workspaces, members, products), as first planned.
  Their unique keys already make a repetition harmless, and two of them cannot be wrapped as
  they are: `createWorkspace` opens its transaction only after it has bound the new
  workspace as the tenant (Row-Level Security), and the catalog invalidates its cache after
  its row is committed, which inside an outer transaction would be before the commit
  (ADR 0010). The conventions say the same in general: require the key where money or an
  irreversible change is involved, not everywhere.
- **An optional header.** The route would be safe only for the clients that send it.
- **The key in Redis with a TTL.** No cleanup job, and no atomicity: the dual write the
  outbox was built to avoid.
- **A row written first, in a transaction of its own, with a status** (`in progress` →
  `done`), to answer the second request while the first runs. A request that dies leaves the
  row `in progress` for ever, and something has to decide when it is dead. The advisory lock
  is released by the database when the transaction ends, however it ends.
- **Waiting for the first request** instead of 409: a second connection held for as long as
  the first one takes, for a client that can simply ask again.
- **Storing error responses too.** A 409 for a stale version would then be the answer to
  the corrected request as well.
- **The key as the id of the order.** Idempotent by the primary key, with no table; but the
  client would choose ids (they are UUIDv7 from the application), and `place` has no id to
  give.

## Consequences

- A retried `POST /orders` creates one draft; a retried `place` is 202 again, with one
  attempt, one saga and one reservation behind it.
- Every client of the two routes has to send the header: the test helper does for every
  request, `docs/requests.http` has it, and the OpenAPI document declares it (`required`).
- One more transaction scope around those two routes, one more row per request, and an
  advisory lock; the use case runs inside a transaction that began before it.
- The stored answer is returned as it was. A response whose shape changes between two
  deploys is replayed in its old shape for the retention.
- After the retention a key is unknown and its request is done again: a client must not
  retry a day later with the same key and expect the same order.
- The fingerprint is of the parsed body: a body that differs only in whitespace or in the
  order of its fields is the same request; one field more is another.
- Known gaps, recorded in `docs/architecture.md`:
  - **A repeated `POST` of a workspace, a member or a product is a 409, not the first
    answer**: nothing is duplicated, but the client has to read what it created.
  - **`cancel` in the saga is repeatable by state, not by key**: the second request is 202
    again and writes nothing (SAGA-022), which is all a key would give.

## What 3.10 starts from

Not decisions: the state this leaves behind.

- **A new write with no natural key** gets `@Idempotent()` on its route, and its use case
  needs nothing: the interceptor opens the transaction the use case joins. It must be
  behind the auth guard (the key is scoped to the user), and its use case must not open a
  transaction of its own in a fresh CLS scope, nor act on "after my commit".
- **`Idempotency.once()` is `Inbox.once()` for HTTP**: the same shape, the same reason. A
  notification that must be sent once per order event is the inbox's case, not this one.
