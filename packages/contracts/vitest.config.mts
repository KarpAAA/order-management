// `.mts`: the package is CommonJS, the config is ESM (same reason as eslint.config.mjs).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
