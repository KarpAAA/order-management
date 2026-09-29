---
paths:
  - 'services/api/stryker.config.*'
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
