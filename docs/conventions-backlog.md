# Conventions backlog

Places where this project went past the shared conventions (`nest-conventions`) **because the
conventions did not foresee the case**. Each entry is a candidate for a change in the
conventions repository, written so that it can be reviewed and moved there later.

This is not the list of project deviations. A choice that is right for this project only
(a patched test runner, a migration that copies rows) stays in `CLAUDE.md` → "Deviations from
the conventions templates". An entry belongs here when the next project would hit the same gap.

How to use it:

- **Adding:** one entry per gap, in the template below, in the same change that introduces it.
- **Reviewing:** decide per entry. Moved into the conventions → `Status: moved to conventions`
  with the file and section. Decided against → `Status: rejected` with one line why. Entries
  are never deleted: the reasoning is the point.

```
## <N>. <title>
Step <x.y> · <date> · Status: open | moved to conventions (<file> §<n>) | rejected (<why>)

**Conventions say:** <file and section, what is written there>
**What we did:** <in a few lines>
**Why:** <what the conventions did not foresee>
**Assessment:** <good or bad, and what it costs>
**Example:** <a short use case or 5–10 lines of code>
**Proposed change:** <what to add, and to which conventions file>
```

---

## 1. A message between services is a schema in a shared package, not a class in the module

Step 3.1 · 2026-10-06 · Status: open

**Conventions say:** `application/events.md` §1 and §5: an integration event is a class in
`<module>/events/*.v1.event.ts` (`EnrollmentCompletedV1 implements IntegrationEvent`), exported
next to the facade. It is written for modules of one service, where "another module via queue"
still shares the codebase.

**What we did:** a command or event that crosses a service boundary is a zod schema in
`packages/contracts`, built with `defineMessage(name, version, payload)`. There is no class
for it in any module; the message is a plain object. Domain events stay classes in
`domain/events/`. Decision and alternatives: `docs/adr/0011-message-contracts.md`.

**Why:** the conventions assume the producer and the consumer compile together. Between
services they do not: the consumer receives bytes, so the contract has to exist at run time,
and it has to be importable by both sides. A class in the publisher's module is neither.
Keeping the class beside the schema would describe the shape twice.

**Assessment:** good. What survives from the conventions is the substance: a stable `name`, a
`version`, an id to deduplicate on, primitives only, a new version for a breaking change.
What changes is the carrier (schema instead of class) and the place (package instead of
module). The cost: `<module>/events/` stays empty in a service that only talks through the
broker, and the "exported next to the facade" rule has nothing to export.

**Example:**

```ts
// packages/contracts/src/payments/charge-payment.v1.ts
export const ChargePaymentV1 = defineMessage(
  'payments.charge-payment',
  1,
  z.object({
    orderId: z.uuid(),
    paymentAttempt: z.int().positive(),
    amount: money,
    idempotencyKey: z.string().min(1),
  }),
);
export type ChargePaymentV1 = z.infer<typeof ChargePaymentV1.schema>;

// producer:  ChargePaymentV1.create(meta, payload)   → validated plain object
// consumer:  parseMessage(JSON.parse(raw))            → { ok, message } | { ok: false, reason }
```

**Proposed change:** `application/events.md` §1: add a third column or a short section,
"message between services": a schema in the contracts package; `name`, `version`, `messageId`
and the envelope fields; validated on both sides; unknown keys ignored. State that the class
form is for modules of one service, and that a project picks one form per boundary.

## 2. A workspace package shared by services has no place in the structure rules

Step 3.1 · 2026-10-06 · Status: open

**Conventions say:** `_core/project-structure.md` §1 describes `src/` of one service.
"Shared" means `src/shared/` (framework-free types) or `src/infrastructure/` (a technical
capability used by two modules). Nothing covers code shared between services.

**What we did:** `packages/contracts` in the pnpm workspace, built to `dist`, with one rule
of its own, enforced by lint: `src/` imports `zod` and its own files, nothing else.

**Why:** the conventions end at the boundary of a service. The first thing two services must
share is the contract between them, and without a rule a shared package grows into a second
`shared/`: helpers, error classes, domain types. Then every service depends on every change,
and the services are a distributed monolith.

**Assessment:** good, with a real cost. Good: one source of truth, and the lint rule keeps the
package a contract and nothing more. Cost: a build order (the package before whatever imports
it), one more thing in every Dockerfile, and a shared package tempts people to believe that
services deploy together. They do not, so the version in the message is still required.

**Example:** `MessageMeta` takes `messageId` and `occurredAt` from the sender. The package
could have called `uuidv7()` and `new Date()`; that would have been its first helper and its
second dependency, so the id generator and the clock stay in each service.

**Proposed change:** `_core/project-structure.md`: a section "Between services":
`packages/<name>` exists for contracts only; what may live there (schemas, the types inferred
from them, the registry) and what may not (logic, domain types, error classes, clients,
anything with a dependency beyond the schema library); built output, not sources; the lint
rule (`import/no-extraneous-dependencies` + `import/no-nodejs-modules`) as the template.

## 3. Who owns a contract: the receiver of a command, the publisher of an event

Step 3.1 · 2026-10-06 · Status: open

**Conventions say:** `application/events.md` §1: an integration event is part of the public
surface of the module that publishes it. §2 treats a write initiated by another module as a
facade call (`PaymentsFacade.requestCharge`). A command sent as a message does not appear.

**What we did:** two kinds of messages with opposite owners. A command is named after and
owned by its receiver (`payments.charge-payment`: it is the receiver's API, the sender
adapts). An event is named after and owned by its publisher (`payments.payment-succeeded`:
the publisher does not know its subscribers and must not break them).

**Why:** inside one service a command to another module is a method on its facade, so its
owner is obvious and it never needed a name. Across a broker the same call is a message, and
without a rule it gets named after whoever wrote it first, usually the sender.

**Assessment:** good and cheap: it is a naming rule. It answers two questions that otherwise
come up at every change: who may change this contract, and who has to stay compatible with
whom.

**Example:** `orders` asks for a charge. In the monolith: `PaymentsFacade.requestCharge(...)`.
Across services: the command `payments.charge-payment` (payments decides its fields), answered
by the events `payments.payment-succeeded` / `payments.payment-failed` (payments decides
those too, and may not remove a field while `orders` reads it).

**Proposed change:** `application/events.md` §2 ("Facade or event"): add the third case, a
command message, as the cross-service form of a facade write; §5 (naming): commands are
`<receiver>.<imperative>`, events `<publisher>.<fact>`, both with a `Vn` suffix on the export.

## 4. A broker consumer is a transport the queue rules do not describe

Step 3.2 · 2026-10-06 · Status: open

**Conventions say:** `transport/queues.md` is written for BullMQ: one queue per module, a
`@Processor` class, `attempts` and `backoff` on the queue, `UnrecoverableError` for what must
not be retried, `concurrency` on the processor. `_core/principles.md` #12 names `@Processor`
and `@WebSocketGateway` as the classes that start on their own.

**What we did:** a class with `@RabbitSubscribe` methods in a `*.consumer.ts`, provided by the
module's `*.worker.module.ts` only. It validates the message against its contract
(`parseMessage`), binds the tenant from the envelope, builds the actor and calls one use
case. Returning acknowledges; `Nack(false)` rejects what is not a known contract;
`InvalidStateError` is "already done" and acknowledges. Concurrency is the prefetch of the
connection, from config. The lint rule and the process-graph test that guard `@Processor`
guard `@RabbitSubscribe` too.

**Why:** the rules name the mechanisms of one backend. With a broker the vocabulary changes
(ack / reject / requeue instead of attempts / backoff, prefetch instead of concurrency, an
exchange and a binding instead of a queue name), and a consumer reads bytes from another
service, so it has to validate before it trusts.

**Assessment:** good. The substance of the queue rules carried over unchanged: thin entry,
one use case, already-done is not a failure, never retry what cannot succeed, the consumer
lives in the worker module. What is missing is the mapping, and one trap: the default of the
library on a thrown error is requeue, which is a hot loop.

**Example:**

```ts
@RabbitSubscribe({ exchange: 'events', routingKey: [PaymentSucceededV1.name], queue: 'api.payment-events' })
async onPaymentEvent(raw: unknown): Promise<Nack | undefined> {
  const parsed = parseMessage(raw);
  if (!parsed.ok) return new Nack(false);              // not a contract: retrying cannot help
  try {
    await this.tenant.runInWorkspace(parsed.message.workspaceId, () => this.settle(parsed.message));
  } catch (err) {
    if (!(err instanceof InvalidStateError)) throw err; // rejected by the connection
  }                                                      // already settled: ack
}
```

**Proposed change:** a `transport/broker.md` beside `queues.md` (or a section in it): the
consumer shape above; the table BullMQ term → broker term; "never requeue at once"; the
queue is declared by its reader; prefetch from config. `_core/principles.md` #12 and the
eslint template: add the subscribe decorator to the entry decorators.

## 5. A second service in the repository: what is copied, what is shared

Step 3.2 · 2026-10-06 · Status: open

**Conventions say:** `_core/project-structure.md` describes one `src/`. `shared/` and
`common/` are folders of that one service; `ops/process-model.md` assumes one image with
several entrypoints.

**What we did:** `services/payments` beside `services/api`, each with its own `src/` in the
same layout, its own image, database, migrations, env schema, lint config and test setup.
They share `packages/contracts` and nothing else: `shared/` (errors, actor, clock, ids) and
`infrastructure/messaging/` exist twice.

**Why:** the conventions do not say what happens to `shared/` when a second service needs
`InfrastructureError`. The two obvious answers are a `packages/shared` and a copy, and the
first one quietly makes two services one deployable.

**Assessment:** good for two services, with a known cost: a fix in a copied file has to be
made twice, and nothing fails when the copies drift. It stays cheap while the copies are
small (here: six files, under 150 lines). The moment a copy holds logic worth a test, it
wants to be a versioned library, not a workspace folder.

**Example:** `src/infrastructure/messaging/rabbit-subscribers.ts` is identical in both
services. `src/shared/auth/actor.ts` is not: payments has no users, so its `Actor` is the
system actor only. A shared package would have forced the union on it.

**Proposed change:** `_core/project-structure.md`, the "Between services" section proposed in
§2: each service is a complete `src/` in the same layout; `shared/` is per service and copied,
not extracted; the contracts package is the only shared code; a per-service `CLAUDE.md`
holds that service's project decisions. `ops/process-model.md`: "one image" is per service.

## 6. A level-1 module with outbound ports

Step 3.2 · 2026-10-06 · Status: open

**Conventions say:** `_core/architecture.md` §4: level 4 is "level 3 + ports", and ports
exist where the implementation genuinely varies. `domain/ports-adapters.md` §7 lists
"`ports/` in a level-3 module" under not doing. A level-1 module is a controller, a service
and a DTO at the module root.

**What we did:** payments in payments-service is level 1 (one or two rules, the service
talks to Prisma directly) and still has `ports/` and `infrastructure/`: a `PaymentGateway`
port with an HTTP adapter and a fake, and a publisher port whose second adapter is the
outbox.

**Why:** the ladder ties ports to the domain level, but the two questions are independent:
"how many rules protect this data" and "does an outbound dependency have more than one
implementation". The conventions already say so for the repository ("a gateway port and a
repository port are separate decisions"); they do not say it for the level.

**Assessment:** good. Raising the module to level 3 to be allowed a gateway port would add an
aggregate, a mapper and a repository for a row with three states. The cost: the module no
longer matches a row of the level table, so its first line has to be read together with its
folders.

**Example:** `// layered · L1 · together`, with `ports/payment-gateway.port.ts` and
`infrastructure/{http,fake}-payment-gateway.adapter.ts` beside `charge-payment.service.ts`.

**Proposed change:** `_core/architecture.md` §4: say that an outbound service port is
orthogonal to the level (axis B is about where the rules live); level 4 then means "a
repository port too". `domain/ports-adapters.md` §7: narrow the anti-pattern to "a port with
one implementation".

## 7. A broker message that fails: delivered again after a delay, then parked

Step 3.3 · 2026-10-08 · Status: open

**Conventions say:** `transport/queues.md` §4: `attempts` and `backoff` on the BullMQ queue,
`UnrecoverableError` for what must not be retried, a dead job goes where `dlq:` says.
`http/error-handling.md`: errors are classes extending the `shared/errors` bases.

**What we did:** every queue a consumer reads has a wait queue (`<queue>.wait.<delayMs>`, a
TTL and a dead-letter route back) and a dead-letter queue (`<queue>.dlq`). One error handler
for the connection decides: `UnprocessableMessageError` → parked at once; anything else →
rejected without requeue while deliveries are left (counted from the broker's `x-death`),
parked on the last one. The consumer only classifies: `InvalidStateError` → return,
`ConflictError` and non-domain errors → let out, any other `DomainError` →
`UnprocessableMessageError`. The number of deliveries and the delay are configuration, per
queue. The subscriber registrar adds the queue arguments and the handler, so the decorator
stays `exchange`, `routingKey`, `queue`. A use case that must answer (a command whose sender
waits) gets "this is the last delivery" in its command and turns the failure into the answer.

**Why:** BullMQ retries inside the library; a broker has no delay and no attempts, only
reject and dead-letter, so the same four notions (attempts, backoff, unrecoverable, dead
letter) have to be built from queues. And the errors bases have no place for "this message
can never be processed", which is neither a domain refusal nor a vendor failure.

**Assessment:** good. The rule of the queue consumer carried over word for word (never retry
what cannot succeed, never retry at once, a dead message is somebody's work), and the
consumer stayed thin. The cost: three queues per reader, and queue arguments that cannot be
changed in place. One trap worth writing down: a consumer class is an entry and may not
import `infrastructure/`, so the error and the delivery type live in `shared/`.

**Example:**

```ts
@RabbitSubscribe({ exchange: 'events', routingKey: [PaymentSucceededV1.name], queue: 'api.payment-events' })
async onPaymentEvent(raw: unknown): Promise<void> {
  const parsed = parseMessage(raw);
  if (!parsed.ok) throw new UnprocessableMessageError(parsed.detail); // parked at once
  try {
    await this.tenant.runInWorkspace(parsed.message.workspaceId, () => this.settle(parsed.message));
  } catch (err) {
    if (err instanceof InvalidStateError) return;                      // already settled: ack
    if (err instanceof ConflictError || !(err instanceof DomainError)) throw err; // again, later
    throw new UnprocessableMessageError(err.message, { cause: err });  // business refuses for good
  }
}
```

**Proposed change:** in the `transport/broker.md` proposed in §4: the three queues and who
declares them; the table error → outcome; "the policy is configuration, per queue"; "a
command handler answers on its last delivery, an event handler parks"; "queue arguments are
immutable: a change is a new name". `shared/errors`: add `UnprocessableMessageError` to the
bases. `ops/config-env.md`: name the two settings every consumed queue has.

## 8. The outbox between services: relayed to a broker, addressed, and used for commands too

Step 3.4 · 2026-10-08 · Status: open

**Conventions say:** `application/transactions.md` §5: a `reliable` event is written to the
`outbox` table in the same transaction; the row is `{ id, name, payload, occurredAt,
publishedAt }`; a polling job takes rows with `FOR UPDATE SKIP LOCKED`, pushes them to
BullMQ and marks them published; the handler is a queue consumer in another module of the
same application. `application/write-service.md` §4: never an adapter call inside
`@Transactional()`. `application/events.md` §1: a domain event that must not be lost is
translated into an integration event class and published as `reliable`.

**What we did:** four things the text does not cover.

1. The relay publishes to the broker between services, through a port (`OutboxPublisher`,
   RabbitMQ adapter; Kafka later), not to BullMQ. It marks a row only after the broker's
   confirm, with a timeout on every publish.
2. The row carries its address (`exchange`, `routing_key`) and the whole envelope of the
   contract. Its id is the message id, chosen when the row is written.
3. A command to another service goes through the outbox as well. It is not an event: the use
   case calls a port inside its transaction (`PaymentChargeScheduler.schedule()`), and the
   adapter appends a row. So an adapter is called inside `@Transactional()`, and that is
   correct: it writes through `txHost.tx` and calls nothing.
4. The translation "reliable domain event → contract" is registered by the module
   (`ReliableEvents.register(OrderPaid, …)`) and applied by `publishAll()`. A reliable event
   with no translation throws.

Two more decisions the text leaves open: one relay at a time (an advisory lock; with
`SKIP LOCKED` alone two relays publish the events of one aggregate out of order), and the
first message that fails ends the pass, so the ones behind it wait.

**Why:** the conventions describe one application whose modules share a Redis. Between
services there is no shared queue: the receiver has its own database and reads a broker, and
a broker needs an address and has failure modes BullMQ does not (a publish that is never
confirmed, a message with no queue). And the conventions know only events, where a
cross-service write is a command (§3 of this file).

**Assessment:** good. The core of the rule carried over unchanged: the message is written
with the change, published afterwards, at least once, and every reader is idempotent. The
cost: more than the `outbox.append(e)` of the text (a publisher port, a registry of
translations, a lock), and the rule "an adapter is never called inside a transaction" now has
a named exception that a reviewer has to recognise. A port that is meant to be called inside
a transaction says so in its comment.

**Example:**

```ts
@Transactional()
async execute(cmd: OrderActionCommand, actor: Actor): Promise<void> {
  const order = await this.orders.getById(cmd.orderId);
  order.place({ now: this.clock.now(), changedBy: actorRef(actor) });
  await this.orders.save(order);
  await this.charges.schedule({ orderId: order.id, … });  // a command: a port, an outbox row
  await this.events.publishAll(order.pullEvents());        // reliable events: outbox rows
}

// the relay, one pass = one transaction
SELECT pg_try_advisory_xact_lock(…);                       -- one relay at a time
SELECT … FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;
-- publish one by one, each confirmed; stop at the first failure
UPDATE outbox SET published_at = now() WHERE id IN (…);
```

**Proposed change:** `application/transactions.md` §5: split "the relay" from "where it
publishes": inside one application, BullMQ; between services, a broker through a publisher
port, marked only on confirm. Add `exchange`/`topic` and the routing key to the row for the
second case, and "the id of the row is the message id". Say that order needs one relay (or a
key per aggregate), and that `SKIP LOCKED` alone does not give it. `application/write-service.md`
§4: narrow "never an adapter call inside `@Transactional()`" to "never a call to the outside";
an adapter that only writes through `txHost.tx` (the outbox) is the allowed case.
`application/events.md` §1: where contracts are schemas in a shared package (§1 of this file),
the translation is registered by the module and applied by the publisher. `transport/cron.md`:
a service without a queue cleans its outbox from a timer.

## 9. A table that deduplicates cannot be partitioned by time

Step 3.5 · 2026-10-08 · Status: open

**Conventions say:** `data/db-general.md` §9: every log-like table (`outbox`,
`webhook_inbox`, `processed_events`, …) is created as `PARTITION BY RANGE` on its time column
in its first migration, and retention is `DROP PARTITION`, never `DELETE`. The same section
states the price: the partition key is part of the primary key and of every `UNIQUE`.

**What we did:** `inbox` (the `processed_events` of the text) is a plain table with the
primary key `(consumer, message_id)`, an index on `processed_at`, and a daily `DELETE` of the
rows older than the retention. `outbox` (3.4) is a plain table as well.

**Why:** the rule and its stated price contradict each other for a table whose whole job is
a unique key. With `processed_at` in the primary key, the same message handled a second later
is a different key: the insert succeeds and the duplicate is handled. The text lists
`processed_events` among the tables to partition without noticing that.

**Assessment:** good for these two tables. The rows are small, the retention is days, and a
`DELETE` by an indexed time column is cheap at that size. It stops being good at millions of
messages a day; the way out then is a partition key that is the same for every copy of a
message (the sender's `occurredAt`, or a range over a UUIDv7 id), which keeps the unique key
at the price of trusting the sender's clock and of a write error for a message with no
partition.

**Example:**

```sql
-- what the rule asks for, and why it does not deduplicate
PRIMARY KEY (consumer, message_id, processed_at)   -- the partition key must be in it
INSERT … (q, m1, '10:00:00.000') ON CONFLICT DO NOTHING;  -- 1 row
INSERT … (q, m1, '10:00:00.250') ON CONFLICT DO NOTHING;  -- 1 row again: not a conflict
```

**Proposed change:** `data/db-general.md` §9: take `processed_events` (and any table whose
unique key must hold without the time) out of the list, with the reason; say that it is
cleaned with `DELETE` by an indexed time column, and name the two partition keys that work
when the volume asks for them. Decide separately whether `outbox` belongs in the list: it has
no such key, only a short life.

## 10. The inbox of a broker consumer: where the record is written, and by whom

Step 3.5 · 2026-10-08 · Status: open

**Conventions say:** `application/transactions.md` §5: every `reliable` handler is
idempotent; the pending-state pattern gives this for free, and a stateless handler records
`processed_events(event_id)` "in their own transaction before acting". `transport/queues.md`
§3: a consumer is thin, with no ORM, no logic and no transaction (the use case has its own).
`transport/webhooks.md` §2 describes an inbox table, for webhooks, with a status.

**What we did:**

1. Every broker consumer records the message, not only the stateless ones: the table is
   `(consumer, message_id)`, and the record is written in the same transaction as the effect,
   as its first statement, with `ON CONFLICT DO NOTHING`.
2. In the api the consumer calls `inbox.once(queue, messageId, () => useCase.execute(…))`. The
   port is in `shared/messaging/` (an entry class may not import `infrastructure/`), the
   implementation opens the transaction, and the `@Transactional()` use case joins it.
3. In payments the use case calls the provider before its only transaction, so the use case
   records the message itself, and its command carries the message id.

**Why:** "in their own transaction before acting" can be read as a separate transaction, and
that reading loses a message: recorded, then the handler fails, and the next delivery is
skipped. The text also leaves open who writes the record when the consumer may not open a
transaction and the use case must not know about messages, and it does not say that one event
has several consumers, each with a record of its own.

**Assessment:** good. One mechanism for every consumer, independent of how the use case
behind it is written; the checks by state stay for a message with another id about the same
fact. The cost: the transaction of the api's use case is opened one level above it, by a
helper the consumer calls, which a reader of `queues.md` §3 would call a transaction in a
consumer. It is not logic in the consumer, and the use case still owns everything inside.

**Example:**

```ts
// *.consumer.ts — after parseMessage(), inside runInWorkspace
const fresh = await this.inbox.once(QUEUE, message.messageId, () => this.settle(message));
if (!fresh) this.logger.log(`${message.name} ${message.messageId} skipped: duplicate`);

// infrastructure/inbox/postgres-inbox.ts
return this.txHost.withTransaction(async () => {
  const { count } = await this.txHost.tx.inboxMessage.createMany({
    data: [{ consumer, messageId, processedAt: this.clock.now() }],
    skipDuplicates: true,
  });
  if (count === 0) return false;
  await handle(); // the use case joins this transaction
  return true;
});
```

**Proposed change:** `application/transactions.md` §5: replace "in their own transaction
before acting" with "in the transaction of the effect, as its first statement, with
`ON CONFLICT DO NOTHING`", and show the three orders that fail. Name the key
`(consumer, event_id)`. Say that the record and the checks by state are two layers.
`transport/queues.md` §3 (or the consumer rule file §4 of this backlog asks for): a broker
consumer calls its use case through the inbox port; when the use case calls the outside
before its transaction, the use case records the message. `transport/webhooks.md` §2: say
how `webhook_inbox` (what arrived, with a status, processed later) differs from this table
(what was handled, no status).

## 11. A use case that must change two aggregates in one transaction

Step 3.6 · 2026-10-09 · Status: open

**Conventions say:** `domain/domain-model.md` §1: the aggregate boundary is the transactional
consistency boundary; everything that must be consistent in one write is inside, everything
else is another aggregate and may be eventually consistent. §8: a domain service is for a
rule that needs two aggregates.

**What we did:** `ReserveStockService` changes the stock items of several products and writes
the reservation that holds them, in one transaction. `StockItem` (one per product) and
`Reservation` (one per attempt of an order) stay two aggregates. The rule across them, "every
line or none", is the domain function `allocate(request, stock, now)`, which reserves on the
items and returns the reservation.

**Why:** §1 gives two ways out and neither fits. One aggregate "the stock of everything an
order touches" does not exist: a stock item is shared by every order. Eventual consistency
between the stock and the reservation would mean units that are held with no reservation to
release them, or the reverse, for as long as the second write is on its way. §8 names the
domain service but does not say that the use case then saves both aggregates in one
transaction, which §1 reads as forbidden.

**Assessment:** good, and unavoidable when one of the aggregates is a shared counter and the
other is the record of who took from it (stock and reservation, balance and transfer, seats
and booking). The cost is that the transaction locks rows of two tables, so the order of the
locks has to be designed (§12).

**Example:**

```ts
// application/reserve-stock.service.ts — inside @Transactional()
const stock = await this.stock.lockMany(cmd.workspaceId, productIds);
const reservation = allocate(cmd, stock, this.clock.now()); // domain: both aggregates
if (reservation.holdsStock) await this.stock.saveAll([...stock.values()]);
await this.reservations.insert(reservation);
```

**Proposed change:** `domain/domain-model.md` §1: add the exception. Two aggregates may be
written in one transaction when one is a shared quantity and the other records a claim on it,
both live in the same module and database, and the rule is a domain service (§8). Say what it
costs (lock order) and that across modules or services it is still an event.

## 12. A repository whose only read takes a lock

Step 3.6 · 2026-10-09 · Status: open

**Conventions say:** `domain/repository-mapper.md` §1: a repository is `findById` / `getById`
/ `insert` / `save`. Concurrency: the default is a `version` column; `SELECT … FOR UPDATE` in
`getById` is the alternative "when a conflict should wait rather than fail".

**What we did:** `StockRepositoryPort` has `lockMany(workspaceId, productIds)`, `insert` and
`saveAll`. There is no read without a lock, `lockMany` throws outside a transaction, and it
takes all the rows a use case needs in one statement, `ORDER BY product_id FOR UPDATE`.
`Reservation`, in the same module, uses the default (`version`).

**Why:** the text does not say when a conflict "should wait", and it describes a lock on one
aggregate. Three things are missing:

1. the criterion. A version lock on a row that many writers want at once makes every loser of
   a round read and try again: 340 retries against none for 50 writers and 25 units
   (`docs/perf/3.6-stock-locking.md`). The criterion is how often a conflict happens, not how
   it should feel;
2. several aggregates of one type locked together, and the deadlock that two use cases get
   when they lock the same rows in a different order;
3. that a plain `findById` next to the locking read is a trap: the next use case reads without
   the lock, and the lost update is back with no error.

**Assessment:** good. The port says in its shape that stock cannot be looked at without being
held. The cost: a transaction holds the row for its whole length, so everything in it must be
short, and nothing outside the database may be called while it runs.

**Example:**

```ts
// ports/stock-repository.port.ts
lockMany(workspaceId: string, productIds: readonly string[]): Promise<Map<string, StockItem>>;

// infrastructure/stock.repository.ts
if (!this.txHost.isTransactionActive()) throw new Error('lockMany() must be called inside a transaction');
const rows = await this.txHost.tx.$queryRaw<StockItemRow[]>`
  SELECT … FROM stock_items
   WHERE workspace_id = ${workspaceId}::uuid AND product_id = ANY(${ids}::uuid[])
   ORDER BY product_id
     FOR UPDATE`;
```

**Proposed change:** `domain/repository-mapper.md` → Concurrency: state the criterion
(optimistic when a conflict is the exception and can be shown to the caller; pessimistic for
a row many writers want at the same moment: counters, balances, stock). For the pessimistic
case: the locking read replaces `findById`/`getById` instead of joining them; it refuses to
run outside a transaction; several rows are locked in one statement with a fixed order.
`application/transactions.md`: a paragraph on lock order across the tables one use case
touches.

## 13. The answer to a command is read from the state, not recorded as a domain event

Step 3.6 · 2026-10-09 · Status: open

**Conventions say:** `domain/domain-model.md` §2, §7: a factory records the creation event;
events are recorded by the aggregate (`this.record()`) and published by the use case
(`pullEvents()`). `application/events.md`: a `reliable` event goes to the outbox.

**What we did:** `StockItem` and `Reservation` record no events and do not extend
`AggregateRoot`. The use case hands the aggregate to a port after saving it
(`publisher.reservationAnswered(reservation, correlationId)`), and the adapter builds the
message from what the aggregate is: `RESERVED` → `stock-reserved`, `REJECTED` →
`stock-reservation-failed` with its shortages, `RELEASED` → `stock-released`. payments does
the same since 3.2 with a row instead of an aggregate.

**Why:** an event recorded by a change exists only when something changed. A command that is
delivered again (another message id, the same key) finds its work done and changes nothing,
and its sender is still waiting for an answer. With recorded events that case needs a second
path that builds the same message from the state, next to the first that builds it from the
event. The conventions describe events as facts for whoever listens, not answers that
somebody waits for.

**Assessment:** good for a module whose every entry is a command that must be answered. One
path, and the answer cannot disagree with the state, since it is derived from it. What is
lost: the domain no longer says what happened, only what is; a module that has both facts for
listeners and answers for a caller would need both mechanisms.

**Example:**

```ts
const settled = await this.reservations.findByAttempt(cmd);
if (settled) {
  // asked again: nothing changes, the answer does not
  await this.publisher.reservationAnswered(settled, cmd.correlationId);
  return;
}
```

**Proposed change:** `application/events.md`: distinguish an event (a fact, recorded by the
change, nobody is waiting) from an answer to a command (derived from the state, given every
time the command is handled, carries the correlation id of that command). Say that a module
that only answers commands may skip `record()`/`pullEvents()`, and that a repeated command is
answered again.

## 14. A process across services: a saga with a state of its own

Step 3.7 · 2026-10-10 · Status: open

**Conventions say:** `application/write-service.md` §4: a slow or outside step is "pending +
queue + second use case": `RequestX` persists a pending state and enqueues, the consumer
calls `CompleteX` / `FailX`. The pending state is a state of the aggregate.
`domain/domain-model.md` §1: one use case changes one aggregate.

**What we did:** placing an order takes two other services, in order, with a compensation
(ADR 0017). The process has an aggregate of its own, `OrderSaga`, one row per attempt, next
to `Order`: the saga holds the step (`RESERVING`, `CHARGING`, `CANCELLING_PAYMENT`,
`RELEASING`, ended), the order keeps one status for the client (`PENDING_PAYMENT`). Each
answer and each timeout is one use case that loads both, lets the saga accept the fact,
changes the order and saves both in one transaction, together with the outbox rows of the
next step. The four things every such use case needs (the repository of the saga and three
outbound ports) are one injectable of `application/`, `OrderSagaSteps`.

**Why:** "pending + queue + second use case" describes one outside step. With two steps the
pending state would have to become several statuses of the order, which are of no use to a
client and change with the process, and a late answer of an earlier attempt would have no
state of its own to be refused by. The conventions also say nothing about what a step does
when it is not answered, or about undoing a step that succeeded.

**Assessment:** good. The order stays what the client sees, the saga is a table of facts and
steps that is tested without a database, and a consumer acknowledges whatever the saga is
not waiting for. The cost: two aggregates in one transaction (as §11), every answer loads
both, and the rule "what the order becomes" is spread over six use cases.

**Example:**

```ts
@Transactional()
async execute(cmd: FailOrderPaymentCommand, actor: Actor): Promise<void> {
  const order = await this.orders.getById(cmd.orderId);
  const saga = await this.sagas.getByAttempt(cmd.orderId, cmd.paymentAttempt);
  saga.paymentEnded(now);                 // not waiting for it → InvalidStateError → ack
  order.markPaymentFailed({ ... });
  await this.sagas.save(saga);            // writes the timeout of the step that begins
  await this.orders.save(order);
  await this.sagas.releaseStock(saga);    // the compensation: an outbox row
}
```

**Proposed change:** a new file `application/sagas.md`: when one outside step becomes a
process (two steps, or a step to undo); the saga as an aggregate per run of the process,
keyed by what makes a run (`orderId` + attempt); a method per fact, `InvalidStateError` for a
fact nobody waits for; the status of the business object changes when its question is
settled, not when the saga ends; every waiting step has a timeout, and a timeout is "I did
not hear", so only a step that cannot have had an effect is given up; a compensation is
safe to repeat and is never given up silently. `domain-model.md` §1: name the saga as the
second case, after §11, where one transaction holds two aggregates.

## 15. A message for later: the broker keeps it, the outbox writes it

Step 3.7 · 2026-10-10 · Status: open

**Conventions say:** `transport/queues.md` §2: a delayed BullMQ job with a deterministic
`jobId` (`expire:enr_123`) is how something happens later. `application/transactions.md`
§5: the outbox is for `reliable` events.

**What we did:** the timeout of a saga step is a message the service sends to itself:
`Outbox.appendDelayed({ queue, delayMs, message })` writes it in the transaction that begins
the step, the relay publishes it to an exchange of the service (`api.delayed`) with the
routing key `<queue>.delay.<ms>`, a queue nobody reads whose messages expire after `<ms>`
and are dead-lettered to `<queue>`, where a normal consumer handles it through the inbox.
The delays of a queue are configuration (`rabbitConfig.delays`), declared with its consumer.

**Why:** a delayed job is written to Redis, next to the transaction, not in it. For "send a
reminder" a lost job is a lost reminder. For a timeout that is the only thing that ends a
wait, a job lost between the commit and `queue.add` is a process that hangs for ever, and
the fix (the deadline in the database, a sweeper for the jobs that were lost) is three
mechanisms. A project that already has an outbox and a broker has the fourth for free.

**Assessment:** good where the broker and the outbox exist; not a reason to add either. One
mechanism, atomic with the state, and the retry and dead-letter rules of every other
message apply. What it costs: a fixed set of delays (a queue each, the delay in the name, a
changed delay leaves an empty queue behind), a message cannot be cancelled (its consumer
must check whether it still counts, which it should anyway), and the wait starts at the
publish, so it is "no earlier than", not "at".

**Example:**

```ts
// in the transaction that moves the saga to the step
const deadline = await this.timeouts.schedule({ workspaceId, orderId, attempt, step });
saga.waitUntil(deadline);

// the consumer, when the delay is over
saga.timedOut(step, now); // the step was answered meanwhile → InvalidStateError → ack
```

**Proposed change:** `transport/queues.md`: say when a delayed job is the wrong tool (when
losing it leaves something waiting for ever) and name the two alternatives: a deadline
column with a sweeper where there is no broker, a delayed message through the outbox where
there is one. `application/transactions.md` §5: the outbox carries whatever must leave with
the commit, a message for later included. A broker rule file (see §4, §7) would hold the
topology: one queue per delay, quorum, `at-least-once` dead-lettering, published
`mandatory`.

## 16. An action that is done at once or only asked for: two success statuses

Step 3.7 · 2026-10-10 · Status: open

**Conventions say:** `http/controller.md` and `http/api-conventions.md` §4: a write answers
with one status: `201` created, `204` done, `202` accepted when the work continues
elsewhere.

**What we did:** `POST …/orders/{id}/cancel` answers `204` when the order is cancelled when
the request returns, and `202 { id, status }` with `Location` when the charge of the order
is under way and the cancellation is with its saga. The use case returns which of the two
happened; the handler returns a body only for the second, and a small interceptor
(`AcceptedWhenPendingInterceptor`) turns a body into `202`, so the controller still does not
touch the response.

**Why:** whether an action is synchronous may depend on the state of the object, not on the
route. Always `202` would make a client poll for a draft that was cancelled in the request;
always `204` would lie about an order that may still become `PAID`.

**Assessment:** acceptable, and to be used rarely: a client has to handle both. It is honest
about what happened, and the two cases are told apart by the status alone.

**Example:**

```ts
@Post(':orderId/cancel')
@HttpCode(204)
@UseInterceptors(AcceptedWhenPendingInterceptor)
async cancelOrder(...): Promise<OrderAcceptedDto | undefined> {
  const outcome = await this.cancelOrderService.execute({ orderId, version }, actor);
  return outcome === 'cancelled' ? undefined : { id: orderId, status: OrderStatus.PendingPayment };
}
```

**Proposed change:** `http/api-conventions.md` §4: allow `204 | 202` on one action when the
state decides whether the work is done, with both documented in OpenAPI and `Location` on
the `202`; `http/controller.md`: the handler returns a body for "accepted" and nothing for
"done", and a shared interceptor sets the status.

## 17. The Idempotency-Key: who opens the transaction, and what "in flight" is

Step 3.7 · 2026-10-11 · Status: open

**Conventions say:** `http/api-conventions.md` §5: money and publish-style endpoints require
an `Idempotency-Key`; the key, the fingerprint, the status and the body are stored in one
table "written in the same transaction as the operation"; a repeat returns the stored
response, another body is `422`, a second request in flight is `409` with `Retry-After`,
"never a wait on a lock held by HTTP". `application/write-service.md`: the use case owns the
transaction.

**What we did:** a method decorator `@Idempotent()` applies a route-level interceptor. The
interceptor calls a port, `Idempotency.once(request, handle)`, which opens the transaction,
takes `pg_try_advisory_xact_lock` on `(user, method + path, key)`, returns the stored
response for a known key, or runs the handler and inserts the row with its response. The
`@Transactional()` use case inside joins that transaction. A request that throws rolls the
key back. The key is required on the two routes that have no natural key to refuse a
repetition (`POST /orders`, `place`), not on the three creating routes that have one.

**Why:** the conventions say what must be true and not how. Three things had to be decided:

- _who opens the transaction._ The row and the write are one transaction, and the use case
  cannot write the row: it does not know the header, the status or the body of the response.
  So the transaction opens around the use case, as it does for a broker consumer with an
  inbox (§10). The same exception to "the use case owns the transaction", for the same
  reason;
- _what "in flight" is._ A row inserted first and committed (`in progress`) answers a
  second request, but a request that dies leaves it behind. A transaction-level advisory
  lock answers it without a row and is released by the database however the request ends;
  it is also the only advisory lock a transaction-mode pooler allows (`db-general.md` §8);
- _which use cases can be wrapped._ One that acts on its own commit (a cache invalidation
  after the write) or that opens its transaction in a new context (to bind a tenant that
  did not exist a moment ago) breaks when a transaction is already open around it.

**Assessment:** good. The use cases did not change, the store is the inbox with a response
in it, and a refused request leaves no trace. The cost is the rule the last point implies:
a use case behind `@Idempotent()` may not assume that its commit is the commit.

**Example:**

```ts
@Post()
@HttpCode(201)
@Idempotent() // 400 without the header; the same key again → the same 201 and body
createOrder(@Body() dto: CreateOrderDto, @CurrentActor() actor: UserActor) { ... }

// the store, in the transaction the use case joins
const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) AS locked`;
if (!lock.locked) throw new IdempotencyKeyInProgressError(key); // 409 + Retry-After
```

**Proposed change:** `http/api-conventions.md` §5: add the mechanics. The key is scoped to
the actor and to the method and path; the transaction is opened by a route-level interceptor
through a port (`once(request, handle)`), and the use case joins it; "in flight" is a
transaction-level advisory lock taken first; only a successful response is stored; say which
writes need no key (a unique natural key, or a `version`). `application/write-service.md`
and `transport/queues.md` §3: name the two cases where the transaction opens around the use
case (the inbox of a consumer, the idempotency key of a route), and what a use case must not
do because of them.

## 18. An effect outside the database caused by a message: a row first, a dispatcher after

Step 3.10 · 2026-10-09 · Status: open

**Conventions say:** `application/write-service.md` §4 and principle 8: "adapters are never
called inside" a transaction. `application/transactions.md` §5: the outbox is for a message
that must leave with a commit. `transport/queues.md` §3: a consumer calls one use case.
Nothing says what a consumer does when the use case _is_ a call to the outside (send a
mail, call a webhook) and the message may be delivered again.

**What we did:** the consumer does not send. Inside `inbox.once()` its use case writes a
row of the module (`notifications`, `PENDING`), with a unique key that names the fact
(`order_id, kind, attempt`). A second use case, driven by a timer of the process, takes one
due row `FOR UPDATE SKIP LOCKED`, calls the adapter, records the outcome on the row and
commits. A failed try is a counter and a later `next_attempt_at` on the row; after the last
one the row is `FAILED` and an error is logged.

**Why:** two rules of the conventions meet and neither covers the case. Sent inside
`inbox.once()`, the mail goes out, the commit fails, and the next delivery sends it again:
the inbox covers only what its transaction holds. Sent after the commit by the consumer, a
process that dies in between loses it. The outbox pattern answers both, but the conventions
describe it for broker messages only.

The dispatcher then calls the adapter _inside_ its transaction, against §4. It is the lesser
evil here: marking the row and sending afterwards loses a mail; this order can only repeat
one, when the process dies between the answer and the commit. The call has a bounded
timeout, and the transaction a longer one.

**Assessment:** good, with a known limit: at-least-once towards a receiver that keeps no
key. It costs a table, a timer and a second use case per kind of effect. Not worth it for an
effect that is itself idempotent (a `PUT` with a key): that one can be called from the
consumer directly.

**Example:**

```ts
// the consumer: a row, in the transaction that records the message
await this.inbox.once(QUEUE, message.messageId, () =>
  this.requestNotification.execute({ workspaceId, recipient, notice }, ACTOR),
);

// the dispatcher: one row per transaction
@Transactional({ timeout: TRANSACTION_TIMEOUT_MS })
async execute(actor: Actor): Promise<DispatchOutcome> {
  const notification = await this.notifications.lockNextDue(this.clock.now());
  if (!notification) return 'idle';
  const outcome = await this.send(notification); // the adapter; marks SENT or records the failure
  await this.notifications.save(notification);
  return outcome;
}
```

**Proposed change:** `application/transactions.md` §5: generalize the outbox from "a message
for the broker" to "anything that must happen outside because of a commit", with the two
shapes: a relay that keeps order (messages) and a dispatcher that does not (independent
effects, retried per row). `application/write-service.md` §4: name the exception, "a
dispatcher of such rows calls its adapter inside the transaction that holds the row, with a
bounded timeout". `transport/cron.md`: a job that loops on a timer inside the process, not on
a schedule, and how it stops.

## 19. A module's adapter that needs another module: the lint map has no way through

Step 3.10 · 2026-10-09 · Status: open

**Conventions say:** `_core/architecture.md` §2: cross-module calls go through the facade.
The lint template (`quality/code-style.md` §5) lets `application/` import another module's
`index.ts`, and `modules/x/infrastructure/` import only `shared`, `common`, `config`, global
infrastructure and its own `domain/` and `ports/`.

**What we did:** the translator of the order events (`orders/infrastructure/`) has to put
the address of a user into a contract. It asks a port of its own module,
`OrderRecipients.of(userId)`, implemented by a class in `application/`
(`OrderRecipientsReader`) that calls `IdentityFacade`. The module binds the two.

**Why:** the conventions place "what leaves the service" in infrastructure and "talk to
another module" in application, and did not foresee an adapter that needs both. The other
ways were worse: the use cases reading the address (seven of them, one already at six
constructor dependencies, and an address in the domain events of orders), or a lint rule
that lets every adapter of every module reach every facade.

**Assessment:** acceptable. The dependency points the right way (infrastructure → port ←
application), and the address stays out of the domain. The cost is an indirection whose only
reason is the lint map: an implementation of a port living in `application/` reads oddly.

**Example:**

```ts
// ports/order-recipients.port.ts
export interface OrderRecipients {
  of(userId: string): Promise<{ userId: string; email: string }>;
}

// application/order-recipients.reader.ts
@Injectable()
export class OrderRecipientsReader implements OrderRecipients {
  constructor(private readonly identity: IdentityFacade) {}
  of(userId: string) {
    return this.identity.getUserContact(userId);
  }
}
```

**Proposed change:** `domain/ports-adapters.md`: say where the implementation of a port
lives when it is another module of the same service (in `application/`, over that module's
facade, named `*.reader.ts`), or allow `modindex` for `modinfra` in the lint template and
say when an adapter may use it. `application/events.md`: a translation of a domain event
into an integration message may be asynchronous and may read; it runs inside the
transaction of the use case.

## 20. A call from a queue that is retried in the adapter too, behind a circuit breaker

Step 3.11 · 2026-10-09 · Status: open

**Conventions say:** `transport/integrations.md` §3: "retry in exactly one layer. A call made
from a queue job does not retry in the adapter: it throws `InfrastructureError { retryable }`
and the job's `attempts` / `backoff` retry it. Retrying in both multiplies the calls (3 × 5)
and holds the worker slot through the adapter's backoff." A circuit breaker is a "MAY, not by
default".

**What we did:** two layers. The adapter makes up to two more calls within the delivery,
after pauses of 200 ms to 2 s with jitter, inside a time budget for the whole operation
(7 s). What it gives up it throws as retryable, and the broker delivers the command again
30 s later, four times in all. A circuit breaker inside the retry counts every call and
stops them while most fail; an open circuit is the same retryable error.

**Why:** the rule assumes a queue whose backoff can be short (BullMQ: exponential from
milliseconds). A broker retry is a wait queue with one fixed delay (§7): 30 s is the right
step for an outage and a bad one for a failure of 50 ms, and it cannot have jitter. The two
layers do not do the same job twice: one hides a hiccup, the other outlives an outage, a
restart, and a failure that is not the vendor's.

**Assessment:** good, on three conditions the rule did not have to state. The inner layer
is small and bounded in time, not only in count: the budget is what keeps a worker slot from
being held (measured: without it a provider that hangs took 6.4 s per message instead of 2).
The outer worst case is written down against whoever waits for the answer (here the saga
timeout of another service). And the breaker is what makes the multiplication harmless when
it matters: against a provider that is down, 19 calls for 20 orders instead of 80. The cost:
a breaker's threshold is a number nobody guesses right. At the usual 50 % it turned a
provider that failed half of its calls into one that was mostly not called, and made the
client wait longer than with no retry at all; it was raised to 80 % after that was measured
(`docs/perf/3.11-resilience.md`).

**Example:**

```ts
// adapter: every operation goes through one policy of the vendor
charge(request: ChargeRequest): Promise<ChargeResult> {
  return this.calls.execute(async ({ signal }) => {          // retry( breaker( call ) ), in a budget
    const response = await this.post('/charges', signal, request);
    return this.read(response);                              // the body is part of the call
  });
}
// use case: unchanged. Retryable and a delivery left → throw; the last delivery → the answer.
```

**Proposed change:** `transport/integrations.md` §3: keep "one layer" as the default and name
the exception: an inner retry is allowed when the outer one cannot be short (a broker wait
queue, a cron), if it has (a) a time budget from config for the whole operation, (b) a
documented worst case of both layers together, (c) an idempotency key at the vendor. Move
the circuit breaker from "may" to "with an inner retry: yes", and say what it counts (calls,
only `retryable`), that it is one per vendor and per process, and that its threshold is
chosen with the retry in mind (a share of failed calls the retry can no longer hide).
`quality/testing.md`: an adapter with a breaker is built per test.

## 21. A message contract has no test of its own: nothing compares it with what is deployed

Step 3.12 · 2026-10-09 · Status: open

**Conventions say:** `quality/testing.md` §5 "Adapters and contracts" knows two tests: an
adapter against MSW fixtures, and Schemathesis against `docs-json` "once the API has an
external consumer". Both are about HTTP. `application/events.md` versions an integration
event by its file name (`*.v1.event.ts`) and says nothing about what keeps a `v1` a `v1`.

**What we did:** three checks, all in the unit run, none with a broker. (1) Every released
version of a contract is a file in git, its JSON Schema and one sample message; a test
compares the contract with it, and one change is allowed: a field that is not required.
(2) A map in the contracts package says who writes each contract and who reads it, with the
rule that a new version gets its readers before its producer. (3) Each service has one spec
that holds it to its rows: what its queues are bound to, the released sample of each
contract through its real consumer, and every contract it writes through its real adapter.

**Why:** in one repository every service compiles against one copy of the contracts, so a
contract changed where it stands breaks the typecheck, the developer fixes the callers, and
everything is green. The break is between two deploys: a message of the old build in a
queue, read by the new one. No test of one commit sees it, and the conventions have no test
of two.

**Assessment:** good, and cheap: about 100 tests in under a second, and the failure names the
field and the file to create. The cost is the map, which is one more place to touch for a
new contract (a red test says so), and generated JSON in the repository that a major of the
schema library may rewrite. What it does not catch: a field that keeps its shape and
changes its meaning.

**Example:**

```ts
// packages/contracts: a version is what it was released as
it('has changed in no way that asks for a new version', () => {
  expect(breakingChanges(releasedSchema(contract), jsonSchemaOf(contract))).toEqual([]);
});
// → [ 'payload.chargeId: removed', 'payload.pspChargeId: new required field' ]

// a service: the old message through the real consumer
it.each(consumedBy('notifications'))('handles $key as it was released', async ({ contract }) => {
  await expect(consumer.onOrderEvent(releasedSample(contract))).resolves.toBeUndefined();
});
```

**Proposed change:** `quality/testing.md` §5: add "message contracts" beside the HTTP ones,
for a project with more than one service: MUST keep the released schema of every version in
the repository and test the contract against it (only an optional field may be added); MUST
have, per service, a test that puts a released sample of every message it reads through its
consumer and builds every message it writes through its adapter; SHOULD keep who writes and
who reads in one map and check the bindings of the queues against it. `application/events.md`:
say that a version is frozen by its release, and that a new version is deployed readers
first. `quality/git-pr.md` §5: the check against the base branch beside the migrations guard.

## 22. The test levels end at one service: nothing runs the services together

Step 3.13 · 2026-10-09 · Status: open

**Conventions say:** `quality/testing.md` has four levels, and the highest is e2e: "does the
system do it end to end?", Supertest + Testcontainers, real Postgres/Redis, **fake vendors**,
files in `test/`, parallel by file, a database per file. "The system" there is one
application.

**What we did:** with four services that level became the test of one of them, with the
test as the other side of the broker. Above it we added a suite outside every service
(`devtools/system`, its own package, no dependency on a service or on the contracts): the
compose project of the `app` profile built from the images, and four scenarios, one per way
an order ends, through the HTTP API. It reads the outside only: the API, the fake provider,
the mail server. Serial, one file, a stack from nothing per run, `eventually()` as the only
wait; on `main` and nightly, not on a pull request.

**Why:** every suite of a service was green with the system unable to start: the compose
file, the Dockerfiles, the migration steps, the queue one service declares and the key
another publishes with are run by no test of one service. And the answers a test gives for
the neighbour are what the author believes the neighbour says.

**Assessment:** good as a small suite, bad as a big one, and the conventions should say both.
Four scenarios take 20 s on a stack that takes one to two minutes to start (nine with cold
images); a scenario cannot put the system into a chosen state (no duplicate, no late answer,
no held step), a failure names no service, and the state is shared, so nothing runs in
parallel. What made it workable: waiting on the history of the order instead of on time,
and one honest hook in the fake vendor (`inFlight`) instead of a sleep. The readiness of the
stack had to be asked of the broker: the services have no health endpoint.

**Example:**

```ts
// devtools/system: a compensation proven by behaviour, through the API alone
await psp.configure({ declineRate: 1 });
await member.place(orderId); // the last unit of its product
expect((await member.untilSettled(orderId, 1)).status).toBe('PAYMENT_FAILED');
await member.untilRecorded(orderId, 'STOCK_RELEASED');

await psp.configure({ declineRate: 0 });
await member.place(orderId);
expect((await member.untilSettled(orderId, 2)).status).toBe('PAID'); // the unit came back
```

**Proposed change:** `quality/testing.md` §1: for a project with more than one service, name
the levels by their boundary: e2e = one service to its boundary (the test is the other side
of every broker and vendor), system = the deployed stack through its public entries. Add a
section "System tests": MUST live outside every service and import none of them; MUST read
the outside only (API, fake vendors, mail), never a database or a queue; MUST be few (one
per end-to-end outcome, never a rule of one service); MUST wait by polling with a deadline,
never by sleeping; MUST save the logs of the stack on every run; SHOULD run on the main
branch and nightly. `ops/observability.md`: a health endpoint per process is what "the stack
is ready" should be asked of.

## 23. The logger rules assume HTTP: a message, a job and a timer have no entry line and no chain

Step 4.1 · 2026-10-10 · Status: open

**Conventions say:** `ops/logging.md` §1: "`correlationId` is added by the logger from CLS.
HTTP: CLS middleware reads `x-correlation-id` or generates one; queue producer stores it in
job `opts`; consumer restores it into CLS; adapters forward it as a header." §3: every HTTP
request is logged once "via `pino-http` or one global interceptor", every consumer job and
every outbound call too, with no word on who writes those lines.

**What we did:** four things the text does not reach. (1) A broker consumer: the class that
starts the subscriptions (`RabbitSubscribers`) runs every delivery in a CLS scope with the
id of the message and writes its line; the error handler, which runs after the handler and
outside its scope, opens the chain again from the message. (2) The request line is written
by the `setup` of the CLS middleware on `finish`, not by an interceptor: a request a guard
refuses never reaches an interceptor. (3) The id of a job goes into its **data**: BullMQ's
`JobsOptions` has no free field. (4) Work that outlives its scope (a mail sent by a timer)
keeps the id in its row, and the timer logs inside that chain. Only a UUID is accepted from
a caller.

**Why:** four of the five processes serve no HTTP, and the fifth is the smallest part of the
path of an order.

**Assessment:** good; the entry is the one place that knows both the id and the outcome, and
a consumer stays free of both. The row for the timer is the part that is easy to forget: the
line everybody looks for (the mail) was the one outside every chain.

**Example:**

```ts
// infrastructure/messaging/rabbit-subscribers.ts: the entry of every message
await this.correlation.run(correlationOf(raw, message), () =>
  this.deliver(subscription, message, raw),
);

// notifications: the dispatcher tells about a mail in the chain its row kept
this.correlation.run(notification.correlationId ?? newId(), () =>
  this.log.info(fields, 'mail sent'),
);
```

**Proposed change:** `ops/logging.md` §1: say "every entry opens or continues the chain" and
list them: HTTP middleware, the subscriber of a broker (id from the message, before its
contract is checked), a job (`data.correlationId`, not `opts`), a timer (the id kept in the
row it works on, or none). Require the caller's id to be a UUID. §3: the request line is
written where a refused request is still seen (middleware), and the line of a delivery by
the subscriber, not by each consumer. `transport/queues.md`: the same for a `@Processor`.

## 24. `redact` "at any depth" is not something pino does

Step 4.1 · 2026-10-10 · Status: open

**Conventions say:** `ops/logging.md` §1: "MUST: `redact` configured for `authorization`,
`cookie`, `password`, `token`, `secret`, `apiKey` at any depth."

**What we did:** pino's `redact` takes paths, and `*` stands for one level. Each key is
listed at three depths (`x`, `*.x`, `*.*.x`), which covers what is logged here: a field, a
field of `err` or `headers`, and one below (`err.details.email`). `email` was added to the
list. A test logs each key at each depth.

**Why:** there is no setting that means "wherever it is", and a serializer that walks every
logged object on every line costs what pino is chosen to avoid.

**Assessment:** acceptable as a net, and the text should stop promising more. What keeps a
secret out is §5 (never a body, a payload or a header), not the redaction. One case no path
catches at all: an address inside a **string** (the reply of a mail server names the
recipient); there the code logs the reply code and not the text.

**Example:**

```ts
// infrastructure/logger/redaction.ts
export const REDACTED_PATHS = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);
```

**Proposed change:** `ops/logging.md` §1: "`redact` for these keys at the depths a logged
object has (a field, a field of a field, one below), proven by a test"; add `email` and
`set-cookie`. §5: add "the message of a vendor's error, when it may quote what was sent".

## 25. A logger is the seventh dependency: the limit of six has no word for it

Step 4.1 · 2026-10-10 · Status: open

**Conventions say:** `quality/code-style.md` §2: at most six constructor dependencies; more
means the class is split. `ops/logging.md` §1: the logger is injected by token.

**What we did:** three answers, by case. The use cases of the api get the logger as a
property set by the injector (`@UseCase()`), and log nothing by hand. `ChargePaymentService`
of payments, which has no such decorator and six dependencies, declares the same property
itself. The three broker consumers of orders needed tenant, correlation, inbox and logger
beside their use cases: the four became one collaborator (`ConsumerScope`). And the use case
of the notification dispatcher stopped logging: it returns what it tried, and its caller
logs.

**Why:** a logger is not something a class works with, and counting it against the limit
pushes real collaborators out.

**Assessment:** the last answer is the best one and should be the default: a use case that
returns its outcome needs no logger. Property injection is honest only because the
decorator hides it in one place; written by hand in a class it is a way around a rule.

**Example:**

```ts
// application: no logger, the outcome is the return value
return { outcome: 'given-up', notification: triedOf(notification), failure };

// the entry logs it, in the right chain
else this.log.error(fields, 'notification given up, its mail was not sent');
```

**Proposed change:** `ops/logging.md` §4: "a use case does not log by hand: what its caller
should tell is its return value; the automatic line comes from `@UseCase()`".
`quality/code-style.md` §2: say whether the logger counts (proposal: it does not, when it is
set by the `@UseCase()` decorator; a class that injects it itself counts it).
`eslint.config.mjs` of the template: forbid `Logger` and `ConsoleLogger` of `@nestjs/common`
outside the test helpers.

## 26. A trace ends where work waits in a table: the outbox, a delayed message, a mail

Step 4.3 · 2026-10-12 · Status: open

**Conventions say:** `ops/observability.md` §3: auto-instrumentation for `http`, `pg`,
`ioredis`, `bullmq` through `getNodeAutoInstrumentations`; the context "propagates through
queues" in the `opts` of a job, by the BullMQ instrumentation; `correlationId = traceId`.
`transactions.md` §5 describes the outbox and says nothing of a trace.

**What we did:** four things the rule does not cover. A row of the outbox keeps the
`traceparent` of the span that wrote it (`outbox.trace_context`), and the relay publishes in
that context: without it every hop through the broker begins a trace. A message that is due
much later (a timeout) keeps it as a link, and its consumer begins a trace that points
back. A table that is an outbox towards a vendor (`notifications`) keeps it the same way.
And the instrumentations are listed one by one, the context of a job is a field of its
data beside `correlationId`, and the two ids stay two.

**Why:** the outbox exists to let go of the request; the instrumentations follow a call,
not a row. `getNodeAutoInstrumentations` is forty packages for five libraries. The
correlation id may come from the caller and follows a delayed message; a trace id does
neither.

**Assessment:** the row carrying the context is right for any project with an outbox, and
the conventions should say so where they describe it. The link for delayed work is a
judgement (ten minutes here); the rule can name the choice. Listing the instrumentations is
better than the meta package. `correlationId = traceId` is still open: 4.4 decides.

**Example:**

```ts
// the write, inside the transaction of the use case
await tx.outboxMessage.create({ data: { …, traceContext: captureTraceContext() } });

// the relay, minutes or milliseconds later, in a timer of another process
await runInTraceContext(record.traceContext, () => this.publisher.publish(record));
```

**Proposed change:** `application/transactions.md` §5: the outbox row has a nullable
`trace_context`, written by `append()` and restored by the relay; delayed work stores a
link. `ops/observability.md` §3: list the instrumentations a project needs instead of the
meta package; say that a context crosses a queue in whatever the project already uses for
the correlation id; add `requireParentSpan` for clients that poll; name `src/instrumentation.ts`
as a process root in the lint template.
