# 0004 — Asynchronous payment through the worker, with the known outbox gap

Date: 2026-09-25 Status: accepted

## Context

Charging a card is slow and fails. It must not run inside an HTTP request or inside an open
database transaction, and a retried charge must never charge twice.

## Decision

- `place` moves the order to `PENDING_PAYMENT` (a real domain state), increments
  `paymentAttempt`, commits, and answers `202`.
- After the commit, the in-process `OrderPlaced` event enqueues BullMQ job `charge-order`
  with a deterministic job id per attempt (`charge-<orderId>-<attempt>`; BullMQ 6 rejects
  `:` in custom ids).
- The worker charges outside any transaction with PSP idempotency key `<orderId>:<attempt>`
  and records the outcome with a second, transactional use case. A stale or duplicate job
  fails the domain guard and is treated as done.
- Declines are outcomes (no retry). Transient failures are retried by BullMQ (5 attempts,
  exponential backoff); the last one records `psp_unavailable`. HTTP timeout is 3 s.
- The enqueue is **not** atomic with the commit, on purpose: the transactional outbox is the
  Step 3 learning item.

## Consequences

- Double charging is prevented twice: by the state machine + attempt number, and by the PSP
  idempotency key.
- Known gap: a crash or Redis outage between commit and enqueue leaves the order in
  `PENDING_PAYMENT` with no job, and `PENDING_PAYMENT` cannot be cancelled until the Step 3
  saga. Documented in `docs/architecture.md` → Known gaps.
