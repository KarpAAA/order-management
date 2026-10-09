# 0021 — Contract tests: a released version is a file, and every service is held to a map of who writes and who reads

Date: 2026-10-09 Status: accepted

## Context

The four services share `@oms/contracts` and nothing else (ADR 0011). Until now three things
stood between a contract and a mistake: `Contract.create()` validates what a producer
builds, `parseMessage()` validates what a consumer reads, and `pnpm typecheck` compiles all
of them against one copy of the package. All three compare the services **of one commit**
with each other, and there they always agree.

A deploy is not one commit. A message written by the build of yesterday waits in a queue (a
wait queue of 30 s, a delay queue of the saga, a dead-letter queue for days, an outbox row
the relay has not published), and the services are deployed one after another. So the rule
of ADR 0011, "an incompatible change is a new file `<name>.v<N+1>.ts`", was held by review
alone. A field renamed in `order-paid.v1.ts` fails the typecheck in the translator of the
api, the developer fixes the translator, and everything is green: notifications of the new
build then parks every `orders.order-paid` of the old one. It happened once on purpose:
`recipient` and the amount were added to `v1` as required fields (3.10), and nothing in CI
noticed.

Two more things were written nowhere but in the code: which service writes a contract, and
which reads it. The binding of a queue (`routingKey: [...]`) and the `switch` of its
consumer are two lists nobody compared, and a `create()` in an adapter is a producer nobody
listed.

## Decision

- **A released version is two files in git**, `packages/contracts/released/<name>.v<N>.json`
  and `<name>.v<N>.sample.json`: the schema as JSON Schema (`z.toJSONSchema(schema, { io:
'input' })`) and one message as its sender wrote it on that day. A version is released by
  the commit that adds its files. They are written by `pnpm contracts:freeze`, never by hand.
- **One change of a released version is allowed: a field that is not required, added
  anywhere.** `breakingChanges(released, current)` (`src/compatibility.ts`) names everything
  else by the path of its field: a removed field, a new required one, one that became
  required or stopped being, another type, another constraint in either direction. Both
  directions count because the order of deploys is not fixed: the new reader meets the old
  message, and the old reader the new one.
- **Four tests per contract** (`src/released.spec.ts`, in `pnpm test`): it is released
  (CTR-001), its schema is the released one (CTR-002), it differs in no way that asks for a
  new version (CTR-003), and it still reads the sample of the day it was released (CTR-004).
  The last one is the old message of the queue, executed.
- **`contracts:freeze` refuses what the test refuses.** A new version: schema and sample are
  written. A compatible change: the schema is written again, so the change is in the diff of
  the pull request; the sample is never written twice. Anything else: exit 1, the list, and
  the name of the file to create.
- **`contracts:check` holds `released/` to the base branch** (`scripts/check-released.mjs`,
  the CI job `contracts`; base = merge base with `CONTRACTS_BASE_REF`, as the migrations
  guard does). The tests compare a contract with the files of the same commit, so a file
  edited or deleted by hand passes them. Against the base: no file may leave, no sample may
  change, a schema changes only in the allowed way.
- **Who writes and who reads is a map in the package** (`src/parties.ts`): a row per
  contract with its exchange, its producers and its consumers. Pure data; no service imports
  another. `partyProblems()` holds the map to three rules: every contract has one row; a
  command is read by the service it is named after and an event written by the one it is
  named after (the naming rule of ADR 0011, now checked); and a service that reads one
  version of a name reads every version somebody writes.
- **The third rule is the order of a migration to `v2`**, the expand and contract of
  messages: (1) the new contract, its readers and no producer; (2) the producer moves;
  (3) the old version loses its readers when no message of it is left. Step 2 before step 1
  does not pass.
- **Each service is held to its rows by one spec**, `src/modules/<m>/<m>.contract.spec.ts`,
  in its unit project:
  - CTR-020: what its `@RabbitSubscribe` methods bind (read from the metadata of the
    decorator) is what the map says it reads, on the exchange the map names;
  - CTR-021: the released sample of each of those contracts goes through the real consumer,
    with spies for the use cases: it does not throw, and one use case is called;
  - CTR-030: a table of the real adapters writes every contract the map says the service
    writes, and no other; each message passes `parseMessage()` after JSON and is addressed
    to the exchange of the map.
- **Old builds are not run.** Inside a version the schema and the sample are the old build.
  Across versions it is the map.
- **The test code of the package is a second entry, `@oms/contracts/testing`**: the readers
  of `released/`, `breakingChanges`, `partyProblems`, `bindingProblems`, the examples. It is
  the only part of the package that imports `node:fs`; `src/index.ts` never imports it.

## Consequences

- A new contract is four things: the file, its line in `registry.ts` and `index.ts` (as
  before), its row in `parties.ts`, its example in `testing/examples.ts`; then
  `pnpm contracts:freeze`. Each one missing is a red test that says which.
- A new routing key in a consumer, or a new `create()` in an adapter, is a change of the
  map: the spec of the service fails until the row says the same.
- What a developer sees after changing a released contract: the typecheck fails in the
  producers and in the example, as before. Fixing them no longer makes the build green:
  CTR-003 names the change and `contracts:freeze` names the file to create.
- The consumers still branch on `message.name` alone, and the routing key is the name: both
  versions of a contract arrive in the same queue and the same `case`. Nothing was changed
  for a `v2` that does not exist; the first one will fail CTR-021 in every consumer that
  reads it until that consumer tells the versions apart.
- `inventory.adjust-stock` has no producer among the services (an operator sends it) and
  `inventory.stock-adjusted` has no reader. The map says so; neither is an error.
- The schema files are generated JSON: `released/` is in `.prettierignore`.
- An upgrade of zod may change the JSON Schema it writes for the same contract (a pattern
  of `z.uuid()`, say). CTR-002 then fails with no contract changed, and `contracts:freeze`
  refuses, because to it a changed pattern is a changed constraint. The files are then
  replaced on purpose (deleted and frozen again, in a commit of its own): visible in the
  pull request, and `contracts:check` has to be read by a person that once.
- Until this branch is merged, `main` has no `released/`: the CI job compares with nothing
  and says so.

## What it looks like

Tried on `orders.order-paid@1`, each change reverted afterwards.

| Change                                                            | What fails                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chargeId` renamed to `pspChargeId`, producers and example fixed  | CTR-003 (`payload.chargeId: removed`, `payload.pspChargeId: new required field`), CTR-002, CTR-004; `contracts:freeze` exits 1 and names `order-paid.v2.ts` |
| a required `paidAt` added                                         | the same three, with `payload.paidAt: new required field`                                                                                                   |
| an optional `note` added                                          | CTR-002 only; `contracts:freeze` writes the schema again, the sample is untouched, then everything is green                                                 |
| a released schema edited by hand, a sample edited, a file deleted | `contracts:check` exits 1 and names each of the three                                                                                                       |
| `OrderPaidV1.name` removed from the routing keys of notifications | CTR-020 of notifications                                                                                                                                    |
| the `case OrderPaidV1.name` removed from `noticeOf()`             | CTR-021 of notifications: `orders.order-paid is not an event of this queue`                                                                                 |
| a row `orders.order-paid@2` written by the api, read by nobody    | CTR-012: `written by api, but notifications reads @1 only`                                                                                                  |

## Rejected

- **Pact.** A consumer-driven contract is a file a consumer writes about what it expects,
  replayed against the provider: the way to agree when the two sides share no schema, live
  in two repositories or belong to two teams. Here the schema is shared and is the source of
  truth; a pact per consumer would say the same thing a second time. It stays deferred until
  there is a synchronous HTTP call between two services (ROADMAP → «Другий прохід»).
- **A schema registry** (the compatibility modes of Confluent's). The same rule, kept by a
  server at publish time. With one repository the rule can be kept by a file and a test, and
  fails before the deploy instead of at the first message. Comes back into view with Kafka
  (3.8).
- **Comparing with the base branch only, no files.** It needs git for every run, says
  nothing on a branch that is its own base, and leaves no sample of the old message to put
  through a consumer.
- **A snapshot test (`toMatchFileSnapshot`).** `vitest -u` rewrites it, and a compatible
  change and a breaking one look the same in it.
- **A declaration of what it reads and writes in every service**, compared by a test above
  the services. That test would import four services; the map in the package is what all of
  them already depend on.
- **Finding the consumers and the producers by scanning the source.** A regular expression
  over `create(` calls reads text, not behaviour. The table of emitters calls the adapter.
- **Running the previous build of a service against the new one.** That is the system test
  of two deploys, minutes long, for something a schema and a sample prove in milliseconds.

## What 3.13 starts from

Not decisions: the state 3.12 leaves behind.

- **Every service is proven against the contracts, none against another service.** The
  contract tests say a message of the api would be read by payments; that it is delivered,
  through the real broker, the real relays and the real queues, is still shown by hand only.
- **The e2e suite of each service still plays the other side of the broker itself**
  (`test/helpers/broker.ts`). Its answers are built with `Contract.create()`, so they follow
  the contracts, not the behaviour of the service they stand for.
- **`docker compose --profile app up --build`** starts all four services and their
  migrations: the ground the scenarios of 3.13 need is there.
