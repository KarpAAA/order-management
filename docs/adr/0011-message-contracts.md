# 0011 — Message contracts: zod schemas in one workspace package, the version inside the message

Date: 2026-10-06 Status: accepted

## Context

Step 3 splits the modular monolith into services that talk through a broker. Until now the
only message in the system is the BullMQ job `charge-order`, and its contract is a TypeScript
interface (`OrdersJobs` in `orders.queue.ts`) that the consumer trusts through an `as` cast.
That holds for three reasons, and all three end with the first separate service (3.2):

- **One codebase.** The producer and the consumer import the same interface. Another service
  has nowhere to import it from, and a copy drifts.
- **One image, one deploy.** api and worker roll out together. Two services deploy on their
  own, so for a while a new producer writes for an old consumer, or the other way round.
- **A nearly empty queue at deploy time.** In a broker a message lives longer: delayed retries
  (3.3), a dead-letter queue, the outbox (3.4). A message written by version N can be read by
  version N+2.

TypeScript types do not exist at run time. A consumer sees a `Buffer`; a renamed field is an
`undefined` that travels into a use case, not a compile error.

## Decision

- **One workspace package, `packages/contracts` (`@oms/contracts`)**, holds the schema of every
  command and event that crosses a service boundary. Producers and consumers import the same
  schema; the TypeScript type is inferred from it (`z.infer`) and never written by hand.
- **zod.** Already in the stack (env validation), every service is TypeScript, and
  `z.toJSONSchema()` produces JSON Schema the day a consumer is not.
- **A message is an envelope around a payload** (`envelope.ts`): `messageId`, `name`,
  `version`, `occurredAt` (ISO string, UTC), `workspaceId`, `correlationId`, `payload`.
  - `messageId` is what a consumer deduplicates on (inbox, 3.5).
  - `workspaceId` is in the envelope, not in the payload: every consumer binds the tenant the
    same way, before it looks at the payload.
  - `correlationId` is carried from now on, so that Step 4 has it in every message.
- **The version travels inside the message.** `name` never changes; `version` changes with an
  incompatible change: a removed or renamed field, a new type or meaning, a new required
  field. Such a change is a new file `<name>.v<N+1>.ts`; the old one stays until no message of
  that version is left in a queue. Adding an optional field keeps the version.
- **Unknown keys are dropped, not rejected.** Otherwise every added field would break the
  consumers that were built before it.
- **Both sides validate.** A producer builds a message with `Contract.create(meta, payload)`,
  which parses what it built; a consumer calls `parseMessage(raw)`, which picks the schema by
  `name` + `version` and returns a result instead of throwing: rejecting or dead-lettering a
  bad message is the consumer's decision (3.3).
- **The owner of a contract is the side that cannot be asked.** A command belongs to its
  receiver (it is the receiver's API; the sender adapts). An event belongs to its publisher
  (the publisher does not know its subscribers and must not break them). The name carries the
  owner: `payments.charge-payment`, `payments.payment-succeeded`.
- **The package stays thin, and lint enforces it.** `src/` imports `zod` and its own files:
  no Node built-ins, no id generator, no clock, no domain types. The sender passes `messageId`
  and `occurredAt`. Money is `{ amountMinor, currency }` with a safe integer, the shape of the
  HTTP API; `bigint` and the `Money` value object stay inside a service.
- **The package is built to `dist` (CommonJS, `tsc`)** and consumed through `exports`.
- **Scope of 3.1:** the envelope, the registry and the three messages of 3.2
  (`ChargePaymentV1`, `PaymentSucceededV1`, `PaymentFailedV1`). A message is added in the step
  that builds its consumer. `charge-order` stays a BullMQ job with its interface: it never
  leaves the api image, and 3.2 replaces it.

## Rejected

- **An integration event class per module** (`<module>/events/*.v1.event.ts`, as the
  conventions describe for one service): the shape would exist twice, in the class and in the
  schema, and a class does not cross a broker anyway. In-process routing by class is what the
  class is for; a broker routes by `name`. Domain events stay classes.
- **Consuming the package as TypeScript sources** (`main: src/index.ts`): works in `pnpm dev`
  and in tests, fails in the image. `pnpm deploy` puts a workspace package into `node_modules`,
  and Node does not strip types there.
- **JSON Schema files as the source**, with generated types: a generation step and a second
  language for one that zod can export on demand.
- **Every message of Step 3 now**: a payload designed before its consumer exists is a guess,
  and a guess that ships needs a `v2`.
- **`.strict()` schemas**: turns every compatible change into a breaking one.
- **A copy of the types in each service**: no build dependency between services, and nothing
  that fails when the copies drift.

## Consequences

- One source of truth: changing a field changes the type on both sides, and the tests of the
  package fail when a contract no longer reads its own example.
- A shared package does not make a deploy atomic. Two services run with two builds of it, so
  the version in the message is still needed, and a consumer that learns `v2` must keep
  reading `v1` until the queues are empty of it.
- Every service depends on this package. A helper or a domain type added here couples all of
  them: the lint rule exists for that reason.
- Known limits, accepted:
  - Nothing yet stops an incompatible edit of an existing `*.v1.ts` in place: the tests of the
    package are edited together with the schema. The check against producers and consumers in
    CI is 3.12.
  - `@oms/api` does not import the package yet. Its dependency, the build order in the api
    `Dockerfile` and `tsc --watch` in `pnpm dev` arrive with the first consumer (3.2).
  - `amountMinor` is a JSON number: amounts above 2^53 minor units are rejected, as in the
    HTTP API.
