# 0010 — Catalog cache: cache-aside in Redis, invalidated by a version, filled from the primary

Date: 2026-10-05 Status: accepted

## Context

The catalog is read far more often than it changes. Every `GET` of a product or of a list
page is a transaction through PgBouncer (`BEGIN`, `set_config`, the query, `COMMIT`) plus the
workspace terms: about 2 ms and five round trips for an answer that is the same as a second
ago. A cache takes these reads off the 20 server connections of ADR 0008.

A cache trades this for stale answers. Three facts of this codebase decide how stale:

- **The read replica (ADR 0009).** Read-your-writes is per user: after an admin changes a
  price, only the admin reads the primary. Anyone else's `GET` reads the replica, which may
  not have replayed the change. Alone that lasts as long as the lag, a millisecond at rest.
  With a cache in front, the first such reader would store the old price for the whole TTL,
  for everyone.
- **A list has many keys**: status filter × limit × cursor, and a new product shifts every
  page of the workspace.
- **Redis knows no tenant.** The tenant scope and Row-Level Security end at the database.

## Decision

- **Cache-aside** for the two reads behind the screens, `CatalogQueryService.get` and `list`:
  read the cache, on a miss read the database and store. `RedisCache`
  (`src/infrastructure/cache/`) is the technical part; the catalog owns its keys
  (`catalog-cache.ts`) and the TTL (`CATALOG_CACHE_TTL_SECONDS`, 300; 0 switches it off).
- **The workspace is in every key**: `<prefix>:catalog:<workspaceId>:v<N>:…`, built in one
  file. The membership guard still runs before the cache.
- **Invalidation is a version per workspace, not a `DEL` per key.** `v<N>` is the value of
  `<prefix>:catalog:<workspaceId>:ver`; every write of `CatalogService` increments it once
  its row is committed. Old keys are never read again and expire. One `INCR` covers the
  product and every list page, and a reader that loaded before the change and stores after
  it writes under the old version.
- **A fill reads the primary.** Before it loads, `RedisCache` takes the replica away from the
  request (`ReadSource.requirePrimary`). This is the rule of ADR 0009 applied once more: what
  is read and then stored reads the primary. The query service still does not choose a
  server. A reader that saw version N+1 reads the primary after the commit that made it N+1.
- **Cache stampede: single-flight in the process, a lock in Redis across processes, TTL with
  jitter.** Callers that miss together share one promise per process; one process holds
  `SET lock NX PX 5000` and loads, the others poll for its value (50 ms, up to 2 s) and then
  load by themselves; the lock is released by its token only. The TTL is spread ±10 % so
  keys stored together do not expire together.
- **Fail open.** Redis not answering is a warning and a read from the database; an
  invalidation that fails is a warning and stale keys until the TTL. No request fails on the
  cache.
- **Not cached:** `findSnapshots` (orders copy its price into an order for good, and it
  already reads the primary, RPL-003), a missing product (404), and the membership check.

## Rejected

- **`DEL` of the product key on a write.** Leaves the list pages (unknown keys, or a `SCAN`),
  and loses the race "read old, the write deletes, store old": the old row stays for the TTL.
- **A read-your-writes marker per workspace**, so that everyone reads the primary after a
  change: rejected in ADR 0009 for busy tenants, and it would still not close the race above.
- **Storing only what the replica served once it caught up** (compare its position with the
  primary's at the write): two more round trips on every miss for what "fill from the
  primary" gives with none.
- **Updating the cache on a write** (write-through): two concurrent writes can store in the
  wrong order, and the DTO is built on the read path (currency from identity).
- **Caching `findSnapshots`**: a stale price in an order is not healed by a refresh.
- **Negative caching** of unknown ids: a 404 costs one indexed read, and a product created
  later would need its own invalidation path.
- **A version per product plus one for the lists**: a product change would keep other
  products warm, at the price of two version reads per list and two `INCR`s per write. One
  version is enough while a catalog changes rarely; `docs/perf/2.9-cache.md` §B shows where
  that stops being true.
- **`@nestjs/cache-manager`**: no namespace versions, no stampede protection, no notion of
  where a fill reads from; what is left is `GET`/`SET`.

## Consequences

- A cache hit is two Redis `GET`s (version, value) and no database round trip; a miss is the
  database read plus five Redis commands (`docs/perf/2.9-cache.md`).
- A change through the API is visible in the next read of everyone, replica lag included
  (CCH-002, CCH-006).
- Known limits, accepted:
  - A write past the API (seed, datagen, `psql`, a test's `testDb()`) invalidates nothing:
    stale for up to the TTL.
  - Between the commit and the `INCR` (milliseconds) a hit still shows the old row; an
    `INCR` that never reached Redis leaves it for the TTL.
  - Any change in a workspace empties its whole catalog cache.
  - A lock holder that dies makes the callers waiting for it 2 s late, once.
  - The version key has no TTL and must not be evicted: Redis runs without `maxmemory`
    eviction here, as BullMQ already requires.
  - A cached product carries the workspace currency. A workspace cannot change it today; an
    endpoint that does must invalidate the catalog namespace.
- The counters of `RedisCache.stats()` live in the process; a metric comes with Step 4.
