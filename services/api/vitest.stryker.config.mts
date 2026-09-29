// The unit project alone, for Stryker (stryker.config.mjs). The Stryker vitest runner has no
// option to pick one project, and loading vitest.config.mts would also load the e2e project
// with its Testcontainers globalSetup, on every mutant.
import { defineConfig } from 'vitest/config';

import base from './vitest.config.mjs';

export default defineConfig({
  resolve: base.resolve ?? {},
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
