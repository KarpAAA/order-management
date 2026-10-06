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
