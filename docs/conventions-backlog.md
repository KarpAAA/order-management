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
