---
paths:
  - 'services/api/stryker.config.*'
  - 'services/api/stryker.ignorers.*'
  - 'services/api/src/modules/*/application/**'
  - 'services/api/test/**'
  - 'services/api/vitest.stryker.config.*'
  - 'services/api/src/shared/domain/money.ts'
---

# Testing — project deviations

- Stryker also mutates `src/shared/domain/money.ts`, outside the conventions glob
  (`src/modules/**/domain|application/**`): the money arithmetic every order total relies on
  (`basisPoints`, `roundHalfUp`, `min`) lives there, and an off-by-one in it costs money.
  Its surviving mutants are treated like `domain/` ones: a missing test.
- Stryker runs through `vitest.stryker.config.mts` (unit project only): the vitest runner
  cannot pick one project, and the e2e project would start Testcontainers per mutant.
- `@stryker-mutator/vitest-runner` is patched (`patches/`, `pnpm-workspace.yaml`) for
  Vitest 5 test names; remove the patch once upstream supports Vitest 5.
- Stryker ignores mutants in the message of `new XxxError(...)` / `super(...)`
  (`stryker.ignorers.mjs`): clients branch on `code` and `details`, which stay mutated and
  tested; a message rewrite is not a missing test.
- Use cases have unit tests (`application/*.service.spec.ts`) on in-memory port doubles from
  `application/__test__/` (repository, recording publisher), beside the e2e
  suite that `testing.md` asks for: they pin the load → policy → domain → save → publish order
  and the payment branches without containers. Never a `vi.mock` of our own code.
- `pnpm test:e2e` of the api runs with `--maxWorkers=75%`: the files run against containers
  on the same machine (Postgres, RabbitMQ, Redis), and since 3.7 most of them start an api
  app, a worker app and a dozen quorum queues. With a worker per core the first test of such
  a file timed out in about half the runs (8 cores); with two cores left to the containers
  it did not in any. Raise it only together with a look at those first tests.
- The API test helper (`test/helpers/api-app.ts`) sends an `Idempotency-Key` of its own with
  every request, as a client would: `http()` is one request. A test about the key sets or
  unsets the header itself.
- An adapter that publishes to the broker (`rabbit-*.adapter.spec.ts`) is tested against a
  recording stand-in for `AmqpConnection`: what it sends must pass `parseMessage()`. The broker
  itself is exercised by the e2e suite of each service, which stops at the service boundary:
  the test is the other side of the broker (`test/helpers/broker.ts`), with a RabbitMQ vhost
  per test file.
- The path through all four services is a suite of its own, outside `services/`:
  `devtools/system` (`pnpm test:system`, ADR 0022). Four scenarios on the stack of
  `docker-compose.system.yml`, through the HTTP API, `fake-psp` and Mailpit. A rule of this
  service is never tested there: it gets a test here, where the test is the other side.
