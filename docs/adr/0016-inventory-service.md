# 0016 — inventory-service: stock is held by locking its row, a reservation is per attempt of an order

Date: 2026-10-09 Status: accepted

## Context

Nothing in the system knows how many units of a product exist. An order for 1000 units of a
product that is not there is placed and charged. The roadmap gives stock to a third service
with a database of its own (3.6), and the saga that uses it to the item after (3.7).

Two things make this service different from payments:

- **Its rows are fought over.** A payment belongs to one order; the stock of a product belongs
  to every order that wants it. Two orders that read "1 free" at the same moment and both
  write "1 held" have sold one unit twice, and no error says so
  (`docs/perf/3.6-stock-locking.md`, table A).
- **Its commands do not carry their own protection.** `reserve` handled twice holds two units,
  `adjust +50` handled twice adds 100, and a `release` may arrive before the `reserve` it
  undoes: a failed message returns behind the ones published meanwhile (ADR 0013).

## Decision

- **A third service, `services/inventory`**, built like payments (ADR 0012): its own image,
  one worker process, its own Postgres (`postgres-inventory`), a role `inventory_app` that
  owns nothing, the tenant as a column, `infrastructure/` and `shared/` copied. It shares
  `@oms/contracts` and nothing else. The api does not change in 3.6: the service is built and
  tested to its boundary, and 3.7 connects it.

- **Three commands in one queue, each answered by an event** (`inventory.commands` on the
  `commands` exchange; answers on `events`):

  | Command                   | Answer                                                             |
  | ------------------------- | ------------------------------------------------------------------ |
  | `inventory.reserve-stock` | `inventory.stock-reserved` or `inventory.stock-reservation-failed` |
  | `inventory.release-stock` | `inventory.stock-released`                                         |
  | `inventory.adjust-stock`  | `inventory.stock-adjusted`                                         |

- **`on_hand` and `reserved`, not one number.** A reservation raises `reserved` and leaves
  `on_hand`; free is the difference. A release is then a subtraction, and what is physically
  there stays readable. This is also what makes the step compensable for the saga: a unit that
  was only held can be given back.

- **A reservation is every line or none.** All lines are checked before anything is held, and
  the rejection names every product that fell short with what was free.

- **The key of a reservation is `(orderId, attempt)`.** An order placed again after a failed
  payment asks for a new reservation, and a late `reserve` of the first placing must not be
  mistaken for it. With `orderId` alone the two cannot be told apart. One row per key, written
  once and changed once at most:

  ```
  (new) → RESERVED → RELEASED
  (new) → REJECTED
  (new) → RELEASED        the release came before its reserve
  ```

  The third line is the answer to messages out of order: a `release` for an attempt the
  service has never heard of is recorded as `RELEASED`, and the `reserve` that arrives later
  finds it and holds nothing.

- **Stock arrives by a command with a difference, `inventory.adjust-stock { productId, delta }`.**
  A level ("set to 7") overwrites whatever happened between the count and the write; a
  difference is added to what the stock is when it is handled. A product heard of for the
  first time gets its stock item here. Stock that reservations hold cannot leave.

- **A domain model** (`// layered · L4 · together`): `StockItem` holds
  `0 <= reserved <= on_hand`, `Reservation` holds the transitions, `allocate()` holds "every
  line or none", which spans both. Repositories and the publisher of answers are ports, so the
  use cases have unit tests on in-memory doubles, as in `orders`.

- **Stock is locked pessimistically.** `StockRepository.lockMany()` is
  `SELECT … ORDER BY product_id FOR UPDATE` over all the products of a command, and it is the
  only way to read stock. The second command that wants a row waits for the first to commit,
  then reads the row as the first left it. `ORDER BY` makes everybody lock in one order: two
  orders that name the same products the other way round queue instead of deadlocking.

- **A reservation is locked optimistically** (`version`, `ConcurrencyError`). Two releases of
  one reservation both read `RESERVED`; the reservation is saved before the stock is touched,
  only one save passes, and the other delivery is rolled back and comes again to find
  `RELEASED`.

- **`CHECK (reserved >= 0 AND reserved <= on_hand)`** in the database, under all of it.

- **The inbox of 3.5 wraps every command** (`inbox.once()` in the consumer, as in the api: the
  use cases are one transaction). It is the only thing that makes `adjust` safe to deliver
  twice. A repetition with another message id is absorbed by state: the reservation of the
  attempt exists, and the command is only answered.

- **An answer is read from the state, not recorded by the change.** A command that finds its
  work done changes nothing and is answered all the same: whoever sent it is waiting. So the
  aggregates record no domain events, and the port has one method per answer.

- **A refusal that will not change is parked, a lost race is retried.** A `ConflictError` (the
  same attempt written by another delivery, the same new product opened twice, a reservation
  that changed) is thrown and the message comes again after `RABBITMQ_RETRY_DELAY_MS` (2 s
  here, not 30: the second try finds what the first writer left). Another `DomainError` (stock
  below what is held, an attempt of another workspace) becomes `UnprocessableMessageError`.

## Rejected

- **A conditional `UPDATE … WHERE on_hand - reserved >= $n`** for the stock. The cheapest way
  (one statement, `docs/perf/3.6-stock-locking.md`) and correct. It puts the rule into SQL, so
  there is no object that holds it and nothing to test without a database. Chosen against for
  the domain model; the `CHECK` keeps the rule in the database as well.
- **Optimistic locking for the stock.** Correct, and nobody waits, but on a row that many want
  every loser of a round retries: 340 retries for 25 units and 50 buyers, against none.
- **`SERIALIZABLE`** instead of explicit locks. Correct too, at the price of serialization
  failures to retry anywhere in the transaction, for a conflict that is known to be on one row.
- **A stock level on `Product` in the api.** No second database to keep consistent, and the hot
  row then sits in the transaction of `place`, next to the order and the outbox.
- **`orderId` as the key of a reservation.** See above: placed again, an order needs a second
  reservation, and a tombstone could not tell a late `reserve` from a new one.
- **An absolute level in `adjust-stock`.** Idempotent by itself, and it silently discards the
  reservations made between the count and the write.
- **Stock set by a seed only, or by an HTTP API of the service.** A seed leaves a running
  system with no way to receive stock. An HTTP API needs to know who the caller is in a
  workspace, which only the api knows.
- **Domain events for the answers**, as in `orders`. A repeated command would have nothing to
  publish; a second path for "answer again" would be needed next to the first.

## Consequences

- A command for a product is as fast as the queue for its row: one transaction at a time per
  product, for the time of a few statements. Orders for different products do not wait for
  each other. A transaction that hangs holding the lock stops that product for everybody.
- Deadlocks between reservations cannot happen as long as every path locks through
  `lockMany()`. A new write path that locks a stock row another way brings them back.
- `release` holds the row of its reservation, then the stock; `reserve` holds the stock, then
  inserts its reservation. They cannot wait for each other: the reservation `reserve` writes
  is a new row.
- A rejected attempt is final: stock that arrives later does not revive it. The order is
  placed again, as a new attempt.
- A product with no stock item is a product with nothing free, not an error. inventory never
  learns which products exist; it learns of a product when stock for it arrives.
- `on_hand` only changes by `adjust`. Nothing takes the units of a paid order out of the
  stock yet: they stay `reserved`. Fulfilment is not in the roadmap of Step 3.
- Three commands share one queue and one retry policy; a command that is parked blocks
  nothing behind it.
- The relay, the outbox, the inbox and `infrastructure/messaging/` now exist three times.
- Known gaps, recorded in `docs/architecture.md`:
  - **Nobody sends these commands yet.** Until 3.7 the stock changes only in the test suite,
    by the seed, or by a message published by hand.
  - **No read side.** Nobody can ask what is in stock over HTTP; `inventory.stock-adjusted`
    is published for whoever will build one.
  - **One migration and no migration checker**, as in payments.
  - **No ledger of adjustments**: the contract carries no reason, and the table keeps levels,
    not movements.

## What 3.7 starts from

Not decisions: the state 3.6 leaves behind, for whoever builds the saga next.

- **The api knows nothing about inventory.** It has to send `inventory.reserve-stock` from the
  outbox when an order is placed (a port called inside `@Transactional()`, like
  `PaymentChargeScheduler`), read `inventory.*` from a queue of its own
  (`*.consumer.ts` + `inbox.once()` + an entry in `rabbitConfig.retry`), and send
  `inventory.release-stock` when the payment fails.
- **`attempt` is `order.paymentAttempt`**: it grows with every `place`, which is exactly "one
  reservation per placing".
- **Lines go as `{ productId, quantity }`**; the same product on two lines is added up here.
- **Every command is answered, and may be answered more than once.** An answer to a repeated
  command is a new message with a new id: the inbox of the api does not absorb it, the state
  of the saga must.
- **`reserve` may be answered with `inventory.stock-released`**: the release got there first.
- **A command that is parked is not answered** (the database was down for every delivery, a
  bug). The saga needs its timeout for that, as it does for payments.
- **`inventory.adjust-stock` has no sender.** An endpoint of the catalog that writes it to the
  outbox is the missing half; `delta` is a difference.
- **Release is the compensation and is safe to send blindly**: for an attempt that was
  rejected, already released, or never reserved.
- `test/helpers/commands.ts` in `services/inventory` builds the three commands; the e2e suite
  of the api will need the mirror image, answers published by the test.
