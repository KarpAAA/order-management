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
  `application/__test__/` (repository, scripted gateway, recording publisher), beside the e2e
  suite that `testing.md` asks for: they pin the load → policy → domain → save → publish order
  and the payment branches without containers. Never a `vi.mock` of our own code.
